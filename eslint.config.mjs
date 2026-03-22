import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/'],
  },
  {
    rules: {
      // Allow unused vars prefixed with _ (common convention for intentionally unused params)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Allow `const self = this` — needed in Proxy handlers where `this` is rebound
      '@typescript-eslint/no-this-alias': [
        'error',
        { allowedNames: ['self'] },
      ],
      // Allow .apply() — needed for forwarding calls through Proxy targets
      'prefer-spread': 'off',
    },
  },
);
