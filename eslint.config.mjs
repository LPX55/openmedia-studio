import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // P5 hardening (o6): the server-side provider modules (registry, adapters,
  // mediaStager, bootstrap) must never enter a client bundle — client
  // readiness/prefs come from GET /api/settings/providers via lib/store.ts +
  // lib/providers.ts. types.ts/bindings.ts stay allowed (pure data).
  {
    files: ["components/**/*.{ts,tsx}", "app/**/page.{ts,tsx}", "lib/providers.ts", "lib/store.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: [
              "@/lib/providers/bootstrap",
              "@/lib/providers/registry",
              "@/lib/providers/mediaStager",
              "@/lib/providers/adapters/*",
              "@/lib/providers/adapters/**",
            ],
            message: "Server-only provider module — client readiness/prefs come from GET /api/settings/providers (lib/store.ts + lib/providers.ts).",
          },
        ],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Desktop build staging area (contains a copied Next.js server tree).
    "src-tauri/**",
  ]),
]);

export default eslintConfig;
