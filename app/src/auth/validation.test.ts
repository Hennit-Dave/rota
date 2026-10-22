import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstInvalidField, loginFieldOrder, signupFieldOrder, validateLogin, validateSignup } from './validation';

test('login: only presence is checked; a short or odd password is left to the server', () => {
  assert.deepEqual(validateLogin({ email: 'a@b.c', password: 'x' }), {});
  assert.deepEqual(validateLogin({ email: '  ', password: '' }), {
    email: 'Enter a valid email address.',
    password: 'Enter your password.',
  });
});

test('login: a password of only spaces is a password (it is not trimmed)', () => {
  assert.deepEqual(validateLogin({ email: 'a@b.c', password: '   ' }), {});
});

test('signup: presence only, no length rule duplicated in the app', () => {
  assert.deepEqual(validateSignup({ name: 'A', email: 'a@b', password: 'short' }), {});
  assert.deepEqual(validateSignup({ name: ' ', email: '', password: '' }), {
    name: 'Enter your name.',
    email: 'Enter a valid email address.',
    password: 'Use at least 15 characters.',
  });
});

test('focus goes to the first invalid field in screen order', () => {
  const errors = { password: 'p', email: 'e' };
  assert.equal(firstInvalidField(loginFieldOrder, errors), 'email');
  assert.equal(firstInvalidField(signupFieldOrder, { password: 'p' }), 'password');
  assert.equal(firstInvalidField(signupFieldOrder, { name: 'n', password: 'p' }), 'name');
  assert.equal(firstInvalidField(signupFieldOrder, {}), null);
});
