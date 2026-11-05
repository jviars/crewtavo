/** A picture in a guide, full screen: pinch, double-tap or the buttons to zoom in, and drag to look around (the file viewer's own picture view). */
import { Dialog } from "@/components/ui/Dialog";
import ImageView from "../files/ImageView";

export function PictureViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const title = alt || "Picture";
  return (
    <Dialog open onClose={onClose} title={title} size="xl" className="picture-dialog">
      <div className="picture-stage">
        <ImageView file={{ path: "", title }} src={src} download={<a className="btn btn-primary" href={src} target="_blank" rel="noopener noreferrer">Open the picture</a>} />
      </div>
    </Dialog>
  );
}
