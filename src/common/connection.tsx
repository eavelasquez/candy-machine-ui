import * as anchor from '@project-serum/anchor';
import {
  Blockhash,
  Commitment,
  Connection,
  FeeCalculator,
  Keypair,
  RpcResponseAndContext,
  SendOptions,
  SignatureStatus,
  SimulatedTransactionResponse,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
} from '@solana/web3.js';
import { WalletNotConnectedError } from '@solana/wallet-adapter-base';
import { getUnixTs, sleep } from './utils';

export const DEFAULT_TIMEOUT = 60000;

interface BlockhashAndFeeCalculator {
  blockhash: Blockhash;
  feeCalculator: FeeCalculator;
}

/**
 * This function is used to get the errors per transaction
 *
 * @param connection Connection to use for the RPC calls
 * @param txid Transaction ID
 * @returns Errors per transaction
 */
export const getErrorForTransaction = async (
  connection: Connection,
  txid: string
): Promise<string[]> => {
  const errors: string[] = [];

  // wait for all confirmation before getting transaction
  await connection.confirmTransaction(txid, 'max');

  // get transaction and check for errors
  const tx = await connection.getParsedTransaction(txid);
  if (tx?.meta && tx.meta.logMessages) {
    tx.meta.logMessages.forEach((log: string) => {
      const regex = /Error: (.*)/gm;
      let match;
      while ((match = regex.exec(log)) !== null) {
        // this avoids infinite loops with zero-width matches
        if (match.index === regex.lastIndex) regex.lastIndex++;

        if (match.length > 1) errors.push(match[1]);
      }
    });
  }

  return errors;
};

/**
 * @param connection Connection to use for the RPC calls
 * @param txid Transaction ID
 * @param commitment Commitment to use for the RPC calls
 * @param queryStatus If true, the function will query the status of the transaction
 * @param timeout Timeout in milliseconds
 */
export const awaitTransactionSignatureConfirmation = async (
  connection: Connection,
  txid: TransactionSignature,
  commitment: Commitment = 'recent',
  queryStatus: boolean = false,
  timeout: number = DEFAULT_TIMEOUT
): Promise<SignatureStatus | null | void> => {
  let done: boolean = false;
  let status: SignatureStatus | null | void = {
    slot: 0,
    confirmations: 0,
    err: null,
  };
  let subId: number = 0;

  status = await new Promise(async (resolve, reject) => {
    setTimeout(() => {
      if (done) return;
      done = true;
      console.error('Rejecting promise due to timeout...');
      reject({ timeout: true });
    }, timeout);

    try {
      subId = await connection.onSignature(
        txid,
        (result, context) => {
          done = true;
          status = { slot: context.slot, confirmations: 0, err: result.err };

          if (result.err) {
            console.error('Rejected via websocket:', result.err);
            reject(status);
          } else {
            console.info('Resolved via websocket:', status);
            resolve(status);
          }
        },
        commitment
      );
    } catch (error) {
      done = true;
      console.error('WS error in setup', txid, error);
    }

    while (!done && queryStatus) {
      (async () => {
        try {
          const signatureStatus = await connection.getSignatureStatuses([txid]);

          status = signatureStatus && signatureStatus.value[0];

          if (!done) {
            if (!status) {
              console.error('REST null result for', txid, status);
            } else if (status.err) {
              console.error('REST error for', txid, status);
              done = true;
              reject(status.err);
            } else if (!status.confirmations) {
              console.error('REST no confirmations for', txid, status);
            } else {
              console.info('REST confirmation for', txid, status);
              done = true;
              resolve(status);
            }
          }
        } catch (error) {
          if (!done) {
            console.error('REST connection error: txid', txid, error);
          }
        }
      })();
      await sleep(2000);
    }
  });

  // @ts-ignore
  if (connection._signatureSubscriptions[subId]) {
    connection.removeSignatureListener(subId);
  }

  done = true;
  console.info('Returning status', status);

  return status;
};

/**
 * This function is used to simulate a transaction
 *
 * @param connection Connection to use for the RPC calls
 * @param transaction Transaction to simulate
 * @param commitment Commitment to use for the RPC calls
 * @returns Simulated transaction response
 */
export const simulateTransaction = async (
  connection: Connection,
  transaction: Transaction,
  commitment: Commitment
): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> => {
  // @ts-ignore
  transaction.recentBlockhash = await connection._recentBlockhash(
    // @ts-ignore
    connection._disableBlockhashCaching
  );

  const signData: Buffer = transaction.serializeMessage();
  // @ts-ignore
  const wireTransaction = transaction._serialize(signData);
  const encodedTransaction = wireTransaction.toString('base64');
  const config: { encoding: string; commitment: Commitment } = {
    encoding: 'based64',
    commitment,
  };
  const args: any[] = [encodedTransaction, config];

  // @ts-ignore
  const response = await connection._rpcRequest('simulateTransaction', args);
  if (response.error) {
    throw new Error(
      'Failed to simulate transaction: ' + response.error.message
    );
  }

  return response.result;
};

export const sendSignedTransaction = async ({
  connection,
  signedTransaction,
  timeout = DEFAULT_TIMEOUT,
}: {
  connection: Connection;
  signedTransaction: Transaction;
  sendingMessage?: string;
  sentMessage?: string;
  successMessage?: string;
  timeout?: number;
}): Promise<{ txid: string; slot: number }> => {
  const rawTransaction = signedTransaction.serialize();

  const startTime = getUnixTs();
  let slot = 0;
  const txid: TransactionSignature = await connection.sendRawTransaction(
    rawTransaction,
    {
      skipPreflight: true,
    }
  );

  console.log('Started awaiting confirmation for', txid);

  let done = false;
  (async () => {
    while (!done && getUnixTs() - startTime < timeout) {
      connection.sendRawTransaction(rawTransaction, { skipPreflight: true });
      await sleep(500);
    }
  })();

  try {
    const confirmation = await awaitTransactionSignatureConfirmation(
      connection,
      txid,
      'recent',
      true,
      timeout
    );

    if (!confirmation) {
      throw new Error('Timed out awaiting confirmation on transaction');
    }

    if (confirmation.err) {
      console.error(confirmation.err);
      throw new Error('Transaction failed: Custom instruction error');
    }

    slot = confirmation?.slot || 0;
  } catch (error: any) {
    console.error('Timeout error caught', error);

    if (error.timeout) {
      throw new Error('Timed out awaiting confirmation on transaction');
    }

    let simulateResult: SimulatedTransactionResponse | null = null;
    try {
      simulateResult = (
        await simulateTransaction(connection, signedTransaction, 'single')
      ).value;
    } catch (error) {
      console.error('Simulate error caught', error);
    }

    if (simulateResult && simulateResult.err) {
      if (simulateResult.logs) {
        for (let i = simulateResult.logs.length - 1; i >= 0; i -= 1) {
          const line = simulateResult.logs[i];

          if (line.startsWith('Program log: ')) {
            throw new Error(`Transaction failed: ${line.slice('Program log: '.length)}`);
          }
        }
      }

      throw new Error(JSON.stringify(simulateResult.err));
    }
  } finally {
    done = true;
  }

  console.log('Latency', txid, getUnixTs() - startTime);
  return { txid, slot };
};

export const sendTransaction = async (
  connection: Connection,
  instructions: TransactionInstruction[] | Transaction,
  signers: Keypair[],
  wallet: anchor.Wallet,
  awaitConfirmation: boolean = true,
  commitment: Commitment = 'singleGossip',
  includesFeePayer: boolean = false,
  block?: BlockhashAndFeeCalculator
): Promise<{ txid: string; slot: number }> => {
  if (!wallet.publicKey) {
    throw new WalletNotConnectedError();
  }

  let transaction: Transaction;
  if (instructions instanceof Transaction) {
    transaction = instructions;
  } else {
    transaction = new Transaction();
    instructions.forEach((instruction) => transaction.add(instruction));

    transaction.recentBlockhash = (
      block || (await connection.getLatestBlockhash(commitment))
    ).blockhash;

    if (includesFeePayer) {
      transaction.feePayer = signers[0].publicKey;
    } else {
      transaction.feePayer = wallet.publicKey;
    }

    if (signers.length > 0) {
      transaction.partialSign(...signers);
    }

    if (!includesFeePayer) {
      transaction = await wallet.signTransaction(transaction);
    }
  }

  const rawTransaction = transaction.serialize();
  const options = { skipPreflight: true, commitment } as SendOptions;

  const txid = await connection.sendRawTransaction(rawTransaction, options);
  let slot: number = 0;

  if (awaitConfirmation) {
    const confirmation = await awaitTransactionSignatureConfirmation(
      connection,
      txid,
      commitment,
      undefined,
      DEFAULT_TIMEOUT
    );

    if (!confirmation) {
      throw new Error('Timed out awaiting confirmation on transaction');
    }

    slot = confirmation?.slot || 0;

    if (confirmation?.err) {
      const errors = await getErrorForTransaction(connection, txid);

      console.error(errors);
      throw new Error(`Raw transaction ${txid} failed`);
    }
  }

  return { txid, slot };
};
