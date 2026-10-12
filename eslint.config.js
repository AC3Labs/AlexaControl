'use strict';

const js = require('@eslint/js');

// Node globals listed by hand to avoid another dev dependency.
const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', __dirname: 'readonly', __filename: 'readonly',
  process: 'readonly', Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly', AbortController: 'readonly',
  globalThis: 'readonly', URL: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**', 'build/**', 'dist/**', 'logs/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
    },
  },
];
