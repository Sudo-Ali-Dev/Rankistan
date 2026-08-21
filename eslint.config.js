import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';

// Flat config. Three distinct runtimes live in this repo and each needs its
// own globals: the browser app (src/), the Node data pipeline (scripts/), and
// the Cloudflare Worker (cloudflare/).
//
// a11y rules are intentionally 'warn' for now: the app has never been linted
// and has a real backlog of gaps (see the audit). Keeping them as warnings
// lets CI gate on genuine errors today without blocking every PR on a
// pre-existing violation, while still surfacing the work in editors.
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'cloudflare/.wrangler/**'
    ]
  },

  // Browser app
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // Real bugs
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', args: 'none' }],

      // react-hooks v7 newly enforces this. Three pre-existing sites trip it
      // (DevCard.jsx:17, BadgeGenerator.jsx:106,113) and each needs a real
      // refactor rather than a lint-driven patch, so surface it without
      // blocking CI on code that predates the linter.
      'react-hooks/set-state-in-effect': 'warn',

      // Vite HMR boundary
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // See header note - staged, not waived.
      'jsx-a11y/alt-text': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/aria-role': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-noninteractive-element-interactions': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/label-has-associated-control': 'warn',
      'jsx-a11y/control-has-associated-label': 'warn',
      'jsx-a11y/no-autofocus': 'warn'
    }
  },

  // Vitest test files
  {
    files: ['src/**/*.{test,spec}.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    }
  },

  // Node data pipeline
  {
    files: ['scripts/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', args: 'none' }]
    }
  },

  // Cloudflare Worker
  {
    files: ['cloudflare/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.worker, ...globals.serviceworker, console: 'readonly' }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', args: 'none' }]
    }
  },

  // Build tooling at the repo root
  {
    files: ['*.config.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    }
  }
];
