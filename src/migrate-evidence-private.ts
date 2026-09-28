import { prisma } from "@/lib/prisma";
import { migrateImageToAuthenticated } from "@/lib/cloudinary";

export function publicIdFromCloudinaryUrl(fileUrl: string): string | null {
  try {
    const url = new URL(fileUrl);
    if (url.hostname !== "res.cloudinary.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const deliveryIndex = parts.findIndex((part) => part === "upload" || part === "authenticated");
    if (deliveryIndex < 0) return null;
    const assetParts = parts.slice(deliveryIndex + 1);
    if (/^v\d+$/.test(assetParts[0] ?? "")) assetParts.shift();
    if (assetParts.length === 0) return null;
    assetParts[assetParts.length - 1] = assetParts[assetParts.length - 1].replace(/\.[a-z0-9]+$/i, "");
    return decodeURIComponent(assetParts.join("/"));
  } catch {
    return null;
  }
}

async function main() {
  const attachments = await prisma.attachment.findMany({
    where: { OR: [{ publicId: { not: null } }, { fileUrl: { contains: "res.cloudinary.com" } }] },
    select: { attachmentId: true, publicId: true, fileUrl: true, format: true },
    orderBy: { uploadedAt: "asc" },
  });
  for (const attachment of attachments) {
    const publicId = attachment.publicId || publicIdFromCloudinaryUrl(attachment.fileUrl);
    if (!publicId) {
      console.warn(`Skipped attachment ${attachment.attachmentId}: Cloudinary public ID could not be recovered`);
      continue;
    }
    if (attachment.publicId && attachment.format && attachment.fileUrl.includes("/authenticated/")) continue;
    const result = await migrateImageToAuthenticated(publicId);
    await prisma.attachment.update({
      where: { attachmentId: attachment.attachmentId },
      data: {
        fileUrl: result.secure_url,
        publicId: result.public_id,
        format: result.format,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
      },
    });
    console.log(`Protected attachment ${attachment.attachmentId}`);
  }
}

main()
  .catch((error) => {
    console.error("Evidence migration failed", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
