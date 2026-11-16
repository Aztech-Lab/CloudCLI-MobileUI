import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProjectPath, projectIdentityKey } from '@/shared/utils.js';

// [local] Windows drive-letter identity, used for grouping and display only.

test('projectIdentityKey treats both drive-letter spellings as one key', () => {
  assert.equal(projectIdentityKey('e:\\Projekt\\VLA'), 'E:\\Projekt\\VLA');
  assert.equal(projectIdentityKey('E:\\Projekt\\VLA'), 'E:\\Projekt\\VLA');
});

test('projectIdentityKey keeps the case of everything after the drive', () => {
  assert.equal(projectIdentityKey('d:\\Server\\cc\\MixedCase'), 'D:\\Server\\cc\\MixedCase');
});

test('projectIdentityKey strips the long-path prefix, trailing separators and whitespace', () => {
  assert.equal(projectIdentityKey('\\\\?\\e:\\Projekt\\VLA'), 'E:\\Projekt\\VLA');
  assert.equal(projectIdentityKey('e:\\Projekt\\VLA\\'), 'E:\\Projekt\\VLA');
  assert.equal(projectIdentityKey('  e:\\Projekt\\VLA  '), 'E:\\Projekt\\VLA');
  assert.equal(projectIdentityKey('e:\\'), 'E:\\');
});

test('projectIdentityKey leaves drive-less paths to normalizeProjectPath', () => {
  assert.equal(projectIdentityKey('/home/user/repo/'), normalizeProjectPath('/home/user/repo'));
  assert.equal(projectIdentityKey('\\\\server\\share\\dir'), '\\\\server\\share\\dir');
  assert.equal(projectIdentityKey(''), '');
  assert.equal(projectIdentityKey(null), '');
  assert.equal(projectIdentityKey(undefined), '');
});

test('normalizeProjectPath, used for storage, still keeps the drive letter as written', () => {
  assert.equal(normalizeProjectPath('e:\\Projekt\\VLA'), 'e:\\Projekt\\VLA');
});
