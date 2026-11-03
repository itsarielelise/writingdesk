import { redirect } from "next/navigation";
import AdminPanel from "@/components/admin/AdminPanel";
import { currentAccess } from "@/lib/server/access";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const access = await currentAccess();
  if (access.state !== "ok") redirect("/");
  if (!access.isAdmin) redirect("/");
  return <AdminPanel me={access.email} />;
}
