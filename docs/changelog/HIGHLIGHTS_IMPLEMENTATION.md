# Highlights Feature Implementation

## Summary
Added complete backend support for user profile Highlights feature, allowing users to create, view, and delete photo/video highlights with cover media.

## Database Schema

### New Table: `highlights`
```sql
CREATE TABLE highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('photo','video')),
    media_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
)
```

### Index
- `idx_highlights_user` on `user_id` for efficient querying of user highlights

## API Endpoints

### 1. GET /api/users/:id/highlights
**Description**: Retrieve all highlights for a specific user, ordered by creation time (oldest first)

**Authentication**: Required

**Response**: 200 OK
```json
[
  {
    "id": 1,
    "title": "Summer Vibes",
    "kind": "photo",
    "cover": "/static/uploads/5d91af2f-ce0d-4865-bfbb-2153b328b1cf.jpg",
    "created_at": "2026-08-24 13:29:11"
  }
]
```

**Error Responses**:
- `401 Unauthorized`: Authentication required
- `404 Not Found`: User not found

---

### 2. POST /api/highlights
**Description**: Create a new highlight with photo or video upload

**Authentication**: Required

**Content-Type**: `multipart/form-data`

**Form Fields**:
- `media` (file): Image or video file
- `title` (string): Title for the highlight (max 20 characters)

**Validation**:
- Title: Required, max 20 characters
- File type: Must be image/* or video/* mimetype
- File size: Max 25MB
- Image extensions: png, jpg, jpeg, gif, webp
- Video extensions: mp4, mov, avi, webm, mkv
- Kind is automatically inferred: image/* → 'photo', video/* → 'video'

**Response**: 201 Created
```json
{
  "id": 1,
  "title": "Summer Vibes",
  "kind": "photo",
  "cover": "/static/uploads/5d91af2f-ce0d-4865-bfbb-2153b328b1cf.jpg",
  "created_at": "2026-08-24 13:29:11"
}
```

**Error Responses**:
- `400 Bad Request`: 
  - `{"error": "No media file provided."}`
  - `{"error": "Title is required."}`
  - `{"error": "Title must be 20 characters or less."}`
  - `{"error": "Only image and video files are supported."}`
  - `{"error": "File must be under 25MB."}`
- `401 Unauthorized`: Authentication required

---

### 3. DELETE /api/highlights/:id
**Description**: Delete a highlight (must be owned by requesting user)

**Authentication**: Required

**Response**: 200 OK
```json
{
  "success": true
}
```

**Error Responses**:
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: `{"error": "You can only delete your own highlights"}`
- `404 Not Found`: `{"error": "Highlight not found"}`

**Side Effects**: 
- Deletes the database row
- Deletes the associated media file from disk

## Implementation Details

### File Storage
- Files are stored in `static/uploads/` with UUID-based filenames
- Same storage mechanism as profile pictures/covers
- Files are automatically cleaned up when highlights are deleted

### Constants Added
```python
ALLOWED_VIDEO_EXTENSIONS = {'mp4', 'mov', 'avi', 'webm', 'mkv'}
MAX_HIGHLIGHT_SIZE = 25 * 1024 * 1024  # 25MB in bytes
```

### Security
- Authentication required for all highlight operations
- Ownership validation on DELETE endpoint
- File type validation by mimetype and extension
- File size validation (25MB limit)
- SQL injection protection via parameterized queries
- Foreign key constraints ensure data integrity

### Frontend Integration Notes
- Response uses "cover" key name (not "media_url") as specified
- Highlights are returned in creation order (ASC)
- Each highlight includes all necessary metadata for display
- Error responses follow the same JSON format as other endpoints

## Testing

All endpoints have been thoroughly tested:
- ✓ Photo upload and retrieval
- ✓ Video upload and retrieval
- ✓ Title validation (required, max 20 chars)
- ✓ File size validation (25MB limit)
- ✓ File type validation
- ✓ Authentication requirements
- ✓ Ownership protection on deletion
- ✓ File cleanup on deletion
- ✓ Multiple highlights per user
- ✓ Cross-user access protection

## Example Usage

### Create a photo highlight
```bash
curl -X POST http://localhost:5050/api/highlights \
  -b cookies.txt \
  -F "media=@photo.jpg" \
  -F "title=Summer 2026"
```

### Get user's highlights
```bash
curl -X GET http://localhost:5050/api/users/1/highlights \
  -b cookies.txt
```

### Delete a highlight
```bash
curl -X DELETE http://localhost:5050/api/highlights/1 \
  -b cookies.txt
```

## Files Modified
- `app.py`: Added constants, database migration, and three new endpoints
- `beebo.db`: New `highlights` table and index created

## Database Migration
The highlights table is automatically created when `init_db()` runs. For existing deployments, simply restart the application or run:
```python
from app import init_db
init_db()
```
