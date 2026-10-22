import { fieldCopy, PASSWORD_HELPER_MIN } from './copy';
import type { FieldErrors, FieldName } from './authFailure';

/**
 * Presence checks only, run when the button is tapped (Figma note 232:415: "re-validate, show errors, focus the first
 * invalid field"). Everything else (email shape, password length, the blocklist) is the server's decision and comes back
 * as error `details` (ADR 0005), so no policy number is duplicated here.
 */
export const loginFieldOrder: readonly FieldName[] = ['email', 'password'];
export const signupFieldOrder: readonly FieldName[] = ['name', 'email', 'password'];

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
