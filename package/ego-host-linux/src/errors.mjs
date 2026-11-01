/** Error helpers that mirror the result shapes of the native ego bindings. */

export function egoError(error, errorCode) {
  return { error, error_code: errorCode };
}

export function isEgoError(value) {
  return Boolean(
    value && typeof value === "object" && typeof value.error_code === "string",
  );
}

export function invalidArgument(message) {
  const error = new TypeError(message);
  error.error_code = "EGO_INVALID_ARGUMENT";
  return error;
}

/** Turn a resolved error object into a rejected Error, as ego.snapshot() does. */
export function rejectionFrom(result) {
  const error = new Error(result.error);
  error.error_code = result.error_code;
  return error;
}
