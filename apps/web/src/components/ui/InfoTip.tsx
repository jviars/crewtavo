/**
 * An (i) after a label or heading that explains it, so a page reads quietly instead of carrying
 * paragraphs. The words are its title: the app's tooltip on hover and keyboard focus (Tooltips.tsx),
 * and its name for a screen reader. A phone has nothing to hover, so a tap says it in a toast.
 */
import { toast } from "@/lib/toast";
import { Icon } from "./Icon";

export function InfoTip({ text }: { text: string }) {
  return (
    <button type="button" className="info-tip" title={text} onClick={() => window.matchMedia?.("(hover: none)").matches && toast.info(text)}>
      <Icon name="info" size={13} />
    </button>
  );
}
