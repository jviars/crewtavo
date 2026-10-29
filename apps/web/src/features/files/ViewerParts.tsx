/** Small pieces every kind of file in the viewer shares: toolbar buttons, zoom, loading and messages. */
import { Component, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Loading, Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import styles from "./files.module.css";

/** A toolbar button: an icon with a short label beside it (the label hides on narrow screens). */
export function ToolButton({ icon, label, showLabel = false, pressed, className, ...rest }: { icon: IconName; label: string; showLabel?: boolean; pressed?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={[styles.tool, className].filter(Boolean).join(" ")} aria-label={label} title={label} aria-pressed={pressed} {...rest}>
      <Icon name={icon} size={18} />
      {showLabel && <span className={styles.toolLabel}>{label}</span>}
    </button>
  );
}

/** Zoom out, how far in it is, zoom in, and back to fitting the screen. */
export function ZoomControls({ percent, onOut, onIn, onFit, canOut = true, canIn = true }: { percent: number | null; onOut(): void; onIn(): void; onFit(): void; canOut?: boolean; canIn?: boolean }) {
  return (
    <div className={styles.group} role="group" aria-label="Zoom">
      <ToolButton icon="zoomOut" label="Zoom out" onClick={onOut} disabled={!canOut} />
      <span className={styles.zoomLabel} aria-live="polite">{percent == null ? "–" : `${Math.round(percent)}%`}</span>
      <ToolButton icon="zoomIn" label="Zoom in" onClick={onIn} disabled={!canIn} />
      <ToolButton icon="maximize" label="Fit to screen" onClick={onFit} />
    </div>
  );
}

/** A sheet of paper while the file opens, with how far along it is once that's known. */
export function StageLoading({ progress, label = "Opening the file" }: { progress?: number | null; label?: string }) {
  return (
    <div className={styles.center}>
      <Loading label={label} className={styles.loadingSheet}>
        <div className={styles.paper}>
          <Skeleton width="55%" height={16} />
          <SkeletonText lines={6} />
          <Skeleton height={120} radius={8} />
          <SkeletonText lines={4} lastWidth="40%" />
        </div>
        {progress != null && progress > 0 && progress < 1 && (
          <div className="progress" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        )}
      </Loading>
    </div>
  );
}

/** A message in place of the file: it can't be shown, it's too big, or it failed to open. */
export function StageMessage({ icon = "file", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.center}>
      <div className={`card ${styles.message}`}><EmptyState icon={icon} title={title} action={action}>{children}</EmptyState></div>
    </div>
  );
}

export function StageError({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className={styles.center}>
      <div className={`card ${styles.message}`}><ErrorState error={error} onRetry={onRetry} title={title ?? "Couldn't open this file"} /></div>
    </div>
  );
}

/**
 * Catches a viewer part that failed: its code didn't download (no signal, or a new version of
 * Crewtavo went out meanwhile) or the file broke the library showing it. Around the whole viewer it
 * brings its own header, so Close still works.
 */
export class ViewerBoundary extends Component<{ children: ReactNode; header?: ReactNode; onRetry?: () => void }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    const retry = () => {
      this.setState({ error: null });
      this.props.onRetry?.();
    };
    const message = <StageError error={this.state.error} onRetry={retry} />;
    if (!this.props.header) return message;
    return (
      <>
        {this.props.header}
        <div className={styles.stage}>{message}</div>
      </>
    );
  }
}
