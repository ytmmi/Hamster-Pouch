/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** UI 变体选择器：test_ui | dev_ui | app_ui */
  readonly VITE_HP_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
