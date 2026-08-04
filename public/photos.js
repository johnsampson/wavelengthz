// Shared between onboarding.html (first-time setup) and settings.html
// (ongoing management) so the upload/remove flow isn't duplicated.
export const MAX_PHOTOS = 10;

// Uploads the file's bytes straight to our own Worker (POST /api/photos),
// not a client-side presigned R2 PUT: a presigned URL points directly at
// R2's S3-compatible endpoint, which in local dev is a completely separate
// storage backend from the `env.PHOTOS` binding the app reads photos
// through -- an upload could "succeed" there and still 404 when displayed.
// Routing bytes through the Worker keeps writes and reads on the same
// binding in every environment, and needs no CORS configuration on the R2
// bucket at all.
export async function uploadPhotoFile(file) {
  const res = await fetch('/api/photos', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      // non-JSON or empty error body -- leave body null
    }
    const err = new Error(`Photo upload failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}
