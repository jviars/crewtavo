import { lazy, Suspense, type ComponentProps } from "react";

const Sparkline = lazy(() => import("./Chart").then((m) => ({ default: m.Sparkline })));

/** A Sparkline that loads the chart library on demand, for screens in the first download (Home). */
export function LazySparkline(props: ComponentProps<typeof Sparkline>) {
  return (
    <Suspense fallback={<div style={{ height: props.height ?? 40 }} aria-hidden="true" />}>
      <Sparkline {...props} />
    </Suspense>
  );
}
