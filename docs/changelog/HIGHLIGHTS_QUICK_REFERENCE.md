# Highlights API - Quick Reference

## Endpoints

### Get User Highlights
```
GET /api/users/:id/highlights
```
Returns array of highlights for the specified user, ordered by creation date (oldest first).

**Response Example:**
```json
[
  {
    "id": 1,
    "title": "Summer Vibes",
    "kind": "photo",
    "cover": "/static/uploads/abc-123.jpg",
    "created_at": "2026-08-24 13:29:11"
  }
]
```

---

### Create Highlight
```
POST /api/highlights
Content-Type: multipart/form-data
```

**Form Data:**
- `media` - Image or video file (max 25MB)
- `title` - String (max 20 characters)

**Response:** 201 Created
```json
{
  "id": 1,
  "title": "Summer Vibes",
  "kind": "photo",
  "cover": "/static/uploads/abc-123.jpg",
  "created_at": "2026-08-24 13:29:11"
}
```

---

### Delete Highlight
```
DELETE /api/highlights/:id
```

**Response:** 200 OK
```json
{
  "success": true
}
```

---

## Validation

| Field | Rule |
|-------|------|
| Title | Required, max 20 characters |
| File Size | Max 25MB |
| Image Types | png, jpg, jpeg, gif, webp |
| Video Types | mp4, mov, avi, webm, mkv |
| Kind | Auto-detected from mimetype |

## Error Codes

| Code | Error |
|------|-------|
| 400 | Invalid input (title too long, file too large, etc.) |
| 401 | Authentication required |
| 403 | Can only delete own highlights |
| 404 | User or highlight not found |

## Notes
- All endpoints require authentication
- Files stored in `static/uploads/` with UUID filenames
- Files automatically deleted when highlight is removed
- `kind` is inferred: `image/*` → `photo`, `video/*` → `video`
- Response uses `cover` key (frontend requirement)
