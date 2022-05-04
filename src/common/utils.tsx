/**
 * @param ms Milliseconds
 * @returns A promise that resolves after ms milliseconds
 */
export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * @returns Get Unix timestamp in seconds
 */
export const getUnixTs = (): number => new Date().getTime() / 1000;
