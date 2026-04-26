import { describe, expect, test } from 'vitest'
import { escapeRegExp } from '../../src/escapeRegExp.js'

describe('escapeRegExp', () => {
  test('escapes regex metacharacters', () => {
    expect(escapeRegExp('foo.bar')).toBe('foo\\.bar')
    expect(escapeRegExp('a*b')).toBe('a\\*b')
    expect(escapeRegExp('(x)')).toBe('\\(x\\)')
    expect(escapeRegExp('a+b?c')).toBe('a\\+b\\?c')
    expect(escapeRegExp('[abc]')).toBe('\\[abc\\]')
    expect(escapeRegExp('a\\b')).toBe('a\\\\b')
    expect(escapeRegExp('a^b$')).toBe('a\\^b\\$')
    expect(escapeRegExp('a|b')).toBe('a\\|b')
    expect(escapeRegExp('{1,2}')).toBe('\\{1,2\\}')
  })

  test('returns plain string unchanged', () => {
    expect(escapeRegExp('hello world')).toBe('hello world')
    expect(escapeRegExp('')).toBe('')
  })
})
