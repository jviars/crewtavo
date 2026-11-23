/**
 * Roofing's tabs: its projects (with how many are open), its packages (with how many there are), and
 * ABC Supply's catalog once ABC Supply is connected (an install that needs attention still shows it,
 * so the problem is one tap away). Underline tabs on a desktop, one segmented control on a phone.
 */
import { Link, useLocation } from "react-router-dom";
import { CATALOG, useSupplier } from "../materials/data";
import { isOpenProject, useRoofingProjects } from "./flow/projects";
import styles from "./flow/projects.module.css";
import { useRoofPackages } from "./packages";

export function RoofingTabs() {
  const { pathname } = useLocation();
  const supplier = useSupplier();
  const projects = useRoofingProjects();
  const packages = useRoofPackages();
  const tab = pathname.startsWith("/roofing/packages") ? "packages" : pathname.startsWith(CATALOG) ? "catalog" : "projects";
  const open = projects.data?.filter((r) => isOpenProject(r.quote)).length;
  const count = (n: number | undefined) => (n ? <span className="badge">{n}</span> : null);
  return (
    <nav className={`underline-tabs ${styles.tabs}`} aria-label="Roofing">
      <Link to="/roofing" aria-current={tab === "projects" ? "page" : undefined}>Projects{count(open)}</Link>
      <Link to="/roofing/packages" aria-current={tab === "packages" ? "page" : undefined}>Packages{count(packages.data?.length)}</Link>
      {(supplier.data || tab === "catalog") && <Link to={CATALOG} aria-current={tab === "catalog" ? "page" : undefined}>Catalog</Link>}
    </nav>
  );
}
