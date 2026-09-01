import { redirect } from "next/navigation";

/** Legacy Explore entry now lands on the unified online-first Home screen. */
export default function ExplorePage(): never {
    redirect("/");
}
