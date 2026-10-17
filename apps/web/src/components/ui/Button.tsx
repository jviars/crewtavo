import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "secondary" | "primary" | "danger" | "danger-solid" | "ghost" | "dark";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  /** Shows a spinner in place of the icon and blocks clicks until the work finishes. */
  loading?: boolean;
  icon?: IconName;
  block?: boolean;
}

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, block, className, disabled, type = "button", children, ...rest },
  ref,
) {
  const iconSize = size === "sm" ? 14 : size === "lg" ? 18 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", variant !== "secondary" && `btn-${variant}`, size !== "md" && `btn-${size}`, block && "btn-block", !children && "btn-icon", loading && "is-loading", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : icon && <Icon name={icon} size={iconSize} />}
      {children}
    </button>
  );
});

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return <span className="spinner" style={{ width: size, height: size }} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
