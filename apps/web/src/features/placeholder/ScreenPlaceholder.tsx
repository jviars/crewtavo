import { Link } from "react-router-dom";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";

/** A link to a screen that isn't there: said plainly on the page itself, no box around it. */
export function NotFound() {
  useDocumentTitle("Page not found");
  return (
    <EmptyState icon="search" title="Page not found" action={<Link className="btn btn-primary" to="/">Go home</Link>}>
      That page doesn't exist or was moved.
    </EmptyState>
  );
}
