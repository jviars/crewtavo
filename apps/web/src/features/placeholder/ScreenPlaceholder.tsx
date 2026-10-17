import { Link } from "react-router-dom";
import { EmptyState } from "@/components/ui/States";

export function NotFound() {
  return (
    <div className="card">
      <EmptyState icon="search" title="Page not found" action={<Link className="btn btn-primary" to="/">Go home</Link>}>
        That page doesn't exist or was moved.
      </EmptyState>
    </div>
  );
}
