import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createPresignedUpload, type UploadFolder } from "@/lib/r2";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const ALLOWED_FOLDERS: UploadFolder[] = [
  "vehicles",
  "financing-contracts",
  "avatars",
  "financing-requests",
];

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json();
  const { fileName, contentType, folder } = body as {
    fileName?: string;
    contentType?: string;
    folder?: string;
  };

  if (!fileName || !contentType || !folder) {
    return NextResponse.json({ error: "Missing fileName/contentType/folder" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(contentType)) {
    return NextResponse.json({ error: `Unsupported content type: ${contentType}` }, { status: 400 });
  }
  if (!ALLOWED_FOLDERS.includes(folder as UploadFolder)) {
    return NextResponse.json({ error: `Unsupported folder: ${folder}` }, { status: 400 });
  }

  try {
    const result = await createPresignedUpload(folder as UploadFolder, fileName, contentType);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Presigned upload error", err);
    return NextResponse.json({ error: "Failed to create upload URL" }, { status: 500 });
  }
}
