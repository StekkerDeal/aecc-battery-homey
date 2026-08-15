import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['lib/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'homey',
              message:
                'lib/ must stay free of the Homey SDK so it can be unit tested without a Homey. Put SDK code in app.ts or drivers/.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
  {
    ignores: ['.homeybuild/', 'node_modules/', 'coverage/', 'app.json'],
  }
);
