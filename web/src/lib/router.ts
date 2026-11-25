import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "new" }
  | { name: "room"; id: string }
  | { name: "review"; id: string }
  | { name: "progress" }
  | { name: "study" }
  | { name: "mirror"; id?: string }
  | { name: "bank"; company: string; role: string; auto: boolean };

function parse(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "bank") {
    const params = new URLSearchParams(query);
    return { name: "bank", company: params.get("company") ?? "", role: params.get("role") ?? "", auto: params.get("auto") === "1" };
  }
  if (parts[0] === "room" && parts[1]) return { name: "room", id: parts[1] };
  if (parts[0] === "review" && parts[1]) return { name: "review", id: parts[1] };
  if (parts[0] === "progress") return { name: "progress" };
  if (parts[0] === "study") return { name: "study" };
  if (parts[0] === "mirror") return { name: "mirror", id: parts[1] };
  if (parts[0] === "new") return { name: "new" };
  return { name: "home" };
}

export function go(path: string) {
  if (window.location.hash !== `#${path}`) window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const update = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

export function bankLink(company: string, role = "", auto = true) {
  const params = new URLSearchParams();
  if (company) params.set("company", company);
  if (role) params.set("role", role);
  if (auto && company) params.set("auto", "1");
  return `#/bank?${params.toString()}`;
}
