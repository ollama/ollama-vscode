export const defaultInferenceTimeoutMinutes = 10;
export const minimumInferenceTimeoutMinutes = 1;
export const maximumInferenceTimeoutMinutes = 60;

export function inferenceTimeoutMilliseconds(value: unknown): number {
  const minutes = typeof value === 'number'
    && Number.isInteger(value)
    && value >= minimumInferenceTimeoutMinutes
    && value <= maximumInferenceTimeoutMinutes
    ? value
    : defaultInferenceTimeoutMinutes;

  return minutes * 60 * 1000;
}
