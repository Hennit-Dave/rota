import { fieldCopy, PASSWORD_HELPER_MIN } from './copy';
import type { FieldErrors, FieldName } from './authFailure';

/**
 * Presence checks only, run when the button is tapped (Figma note 232:415: "re-validate, show errors, focus the first
 * invalid field"). Everything else (email shape, password length, the blocklist) is the server's decision and comes back
 * as error `details` (ADR 0005), so no policy number is duplicated here.
 */
export const loginFieldOrder: readonly FieldName[] = ['email', 'password'];
export const signupFieldOrder: readonly FieldName[] = ['name', 'email', 'password'];

export const forgotFieldOrder: readonly FieldName[] = ['email'];
export const resetFieldOrder: readonly FieldName[] = ['password', 'confirm'];

/** The forgot-password and magic-link requests need only an address; whether it is shaped like one is the server's call (details). */
export function validateEmailOnly(input: { email: string }): FieldErrors {
  return input.email.trim() === '' ? { email: fieldCopy.emailInvalid } : {};
}

/**
 * The new-password form. Length and the blocklist are the server's decision and come back as `details`; the app only checks that the two
 * entries are there and match, because a mismatch is a typo the server cannot see (it is only sent the password).
 */
export function validateNewPassword(input: { password: string; confirm: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (input.password === '') errors.password = fieldCopy.passwordTooShort(PASSWORD_HELPER_MIN);
  if (input.confirm === '') errors.confirm = fieldCopy.confirmRequired;
  else if (input.password !== '' && input.confirm !== input.password) errors.confirm = fieldCopy.confirmMismatch;
  return errors;
}

export function validateLogin(input: { email: string; password: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (input.email.trim() === '') errors.email = fieldCopy.emailInvalid;
  if (input.password === '') errors.password = fieldCopy.passwordRequired;
  return errors;
}

export function validateSignup(input: { name: string; email: string; password: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (input.name.trim() === '') errors.name = fieldCopy.nameRequired;
  if (input.email.trim() === '') errors.email = fieldCopy.emailInvalid;
  if (input.password === '') errors.password = fieldCopy.passwordTooShort(PASSWORD_HELPER_MIN);
  return errors;
}

/** The first field, in screen order, that has an error. Focus goes there. */
export function firstInvalidField(order: readonly FieldName[], errors: FieldErrors): FieldName | null {
  return order.find((field) => errors[field] !== undefined) ?? null;
}
