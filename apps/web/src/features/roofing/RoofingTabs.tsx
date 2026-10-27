/**
 * Roofing's tabs: its projects, its packages, and ABC Supply's catalog once ABC Supply is connected
 * (an install that needs attention still shows it, so the problem is one tap away).
 */
import { Link, useLocation } from "react-router-dom";
import { CATALOG, useSupplier } from "../materials/data";
import styles from "./RoofPackagesPage.module.css";

export function RoofingTabs() {
  const { pathname } = useLocation();
  const supplier = useSupplier();
  const tab = pathname.startsWith("/roofing/packages") ? "packages" : pathname.startsWith(CATALOG) ? "catalog" : "projects";
  return (
    <nav className={`underline-tabs ${styles.tabs}`} aria-label="Roofing">
      <Link to="/roofing" aria-current={tab === "projects" ? "page" : undefined}>Projects</Link>
      <Link to="/roofing/packages" aria-current={tab === "packages" ? "page" : undefined}>Packages</Link>
      {(supplier.data || tab === "catalog") && <Link to={CATALOG} aria-current={tab === "catalog" ? "page" : undefined}>Catalog</Link>}
    </nav>
  );
}
