"""Small disk-upload helpers shared across services that store user
uploads under static/uploads/ (profile pictures, covers, highlights,
post images).
"""
import os


def delete_if_local(url, upload_folder):
    """Best-effort cleanup of a previously uploaded file when it's
    replaced or its owning record is deleted. Silently no-ops for None,
    external URLs, or anything outside upload_folder - never let
    cleanup failure break the request.
    """
    if not url or not url.startswith('/static/uploads/'):
        return
    try:
        filename = os.path.basename(url)
        full_path = os.path.join(upload_folder, filename)
        if os.path.commonpath([os.path.abspath(full_path), os.path.abspath(upload_folder)]) == os.path.abspath(upload_folder):
            if os.path.exists(full_path):
                os.remove(full_path)
    except OSError:
        pass
