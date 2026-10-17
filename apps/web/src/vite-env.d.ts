/// <reference types="vite/client" />

import "react";

declare module "react" {
  // The Popover API (top-layer menus and toasts); React 18's types predate it.
  interface HTMLAttributes<T> {
    popover?: "auto" | "manual" | "";
  }
  interface ButtonHTMLAttributes<T> {
    popovertarget?: string;
    popovertargetaction?: "toggle" | "show" | "hide";
  }
}
