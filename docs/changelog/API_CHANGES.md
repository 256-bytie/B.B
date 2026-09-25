# Backend API Changes for Image Attachments & Audience/Category

## Summary

Extended the existing Flask backend to support:
1. **Image attachments** (up to 4 per post)
2. **Audience/category** field (Academic, Announcements, Events, Community, General)
3. **Character limit enforcement** (1000 chars, mirroring comments)
4. **Feed filtering** by audience

All changes follow existing patterns: session-based auth, manual sqlite3 connections, JSON error responses, row_to_dict mapping style.

---

## Schema Changes

### 1. `posts` table - Added `audience` column
```sql
ALTER TABLE posts ADD COLUMN audience TEXT DEFAULT 'Academic'
```

### 2. New `post_images` table
```sql
CREATE TABLE post_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
)
```

---

## API Endpoints Modified

### POST /api/posts

**Previously:** JSON-only, accepted `{ content }`

**Now:** Accepts BOTH formats for backward compatibility:

#### Format 1: JSON (no images, backward compatible)
```json
{
  "content": "Post content here",
  "audience": "Academic"  // optional, defaults to "Academic"
}
```

#### Format 2: multipart/form-data (with images)
```
Content-Type: multipart/form-data

Fields:
  - content: string (required)
  - audience: string (optional, default: "Academic")
  - images: File[] (optional, max 4 files)
```

**Request Example (JavaScript):**
```javascript
const formData = new FormData();
formData.append('content', composeState.content);
formData.append('audience', composeState.audience); // "Academic", "Events", etc.

// Append each image file
composeState.images.forEach(img => {
  formData.append('images', img.file); // img.file is the actual File object
});

const response = await fetch('/api/posts', {
  method: 'POST',
  body: formData,
  credentials: 'include'  // for session cookie
});
```

**Validation Rules (server-side):**
- `content` required, 1-1000 characters → 400 if violated
- `audience` must be one of: `Academic`, `Announcements`, `Events`, `Community`, `General` (defaults to `Academic` if invalid/missing)
- `images` max 4 files → 400 `{'error': 'A post can have at most 4 images.'}`
- Each file must be `image/*` mime type → 400 `{'error': 'Only image files are supported.'}`
- Each file must be ≤ 5MB → 400 `{'error': 'Each image must be under 5MB.'}`

**Response (201):**
```json
{
  "id": 123,
  "user_id": 1,
  "content": "Post content",
  "audience": "Academic",
  "created_at": "2026-08-22 12:34:56",
  "comment_count": 0,
  "like_count": 0,
  "view_count": 0,
  "author_name": "John Doe",
  "author_handle": "john",
  "liked_by_user": false,
  "images": [
    "/static/uploads/abc123-def456.png",
    "/static/uploads/xyz789.jpg"
  ]
}
```

**Error Responses:**
- 401: `{'error': 'Authentication required'}`
- 400: `{'error': 'Content cannot be empty'}`
- 400: `{'error': 'Post exceeds 1000 character limit.'}`
- 400: `{'error': 'A post can have at most 4 images.'}`
- 400: `{'error': 'Only image files are supported.'}`
- 400: `{'error': 'Each image must be under 5MB.'}`
- 500: `{'error': 'Database error: ...'}`

---

### GET /api/posts

**Previously:** Returned posts without `audience` or `images` fields

**Now:** Returns posts with both fields, plus optional audience filtering

**Query Parameters:**
- `audience` (optional): Filter by audience category
  - Example: `GET /api/posts?audience=Events`
  - Valid values: `Academic`, `Announcements`, `Events`, `Community`, `General`
  - Omit parameter to get all posts (default behavior)

**Response (200):**
```json
[
  {
    "id": 123,
    "user_id": 1,
    "content": "Post content",
    "audience": "Events",           // NEW FIELD
    "created_at": "2026-08-22 12:34:56",
    "comment_count": 5,
    "like_count": 10,
    "view_count": 50,
    "author_name": "John Doe",
    "author_handle": "john",
    "liked_by_user": true,
    "images": [                     // NEW FIELD
      "/static/uploads/abc123.png",
      "/static/uploads/xyz789.jpg"
    ]
  }
]
```

**Error Responses:**
- 400: `{'error': 'Invalid audience filter'}` (if invalid audience value)
- 500: `{'error': 'Database error: ...'}`

---

### GET /static/uploads/<filename>

**New endpoint** to serve uploaded images.

**Example:** `GET /static/uploads/abc123-def456.png`

Returns the image file with appropriate mime type.

---

## Frontend Integration Instructions

### 1. Update the POST /api/posts call in beebo.html

**Find the current code** (likely in `composePost()` or similar):
```javascript
// OLD (JSON-only):
const response = await fetch('/api/posts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: composeState.content }),
  credentials: 'include'
});
```

**Replace with:**
```javascript
// NEW (multipart with images):
const formData = new FormData();
formData.append('content', composeState.content);
formData.append('audience', composeState.audience);

// Append images if present
if (composeState.images && composeState.images.length > 0) {
  composeState.images.forEach(img => {
    // img.file should be the File object from the file input
    // If you stored dataUrls, you'll need to convert back to File/Blob
    formData.append('images', img.file);
  });
}

const response = await fetch('/api/posts', {
  method: 'POST',
  body: formData,  // No Content-Type header - browser sets it with boundary
  credentials: 'include'
});
```

**Important:** The frontend currently stores images as `{ dataUrl, name }` in `composeState.images`. You need to keep the original `File` objects instead:

```javascript
// When user selects files:
fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  composeState.images = files.map((file, index) => ({
    file: file,           // Keep the original File object
    dataUrl: URL.createObjectURL(file),  // For preview
    name: file.name
  }));
});
```

### 2. Display images in posts

Posts now have an `images` array. Render them in the post template:

```javascript
function renderPost(post) {
  // ... existing post rendering ...
  
  // Add image rendering
  if (post.images && post.images.length > 0) {
    const imagesHtml = post.images.map(imgUrl => 
      `<img src="${imgUrl}" alt="Post attachment" class="post-image">`
    ).join('');
    
    // Insert imagesHtml into post card
  }
}
```

### 3. Wire up audience filter to top nav tabs

The existing top nav tabs (For You, Announcements, Academic, Events, Community) can now filter the feed:

```javascript
// Add click handlers to nav tabs:
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const audience = tab.dataset.audience; // e.g., "Academic"
    
    if (audience === 'for-you') {
      loadPosts(); // No filter, all posts
    } else {
      loadPosts(audience); // Filtered
    }
  });
});

async function loadPosts(audience = null) {
  const url = audience 
    ? `/api/posts?audience=${encodeURIComponent(audience)}`
    : '/api/posts';
  
  const response = await fetch(url, { credentials: 'include' });
  const posts = await response.json();
  renderPosts(posts);
}
```

### 4. Display audience badge on posts

Each post now has an `audience` field. Add a visual indicator:

```javascript
function renderPost(post) {
  const audienceBadge = `<span class="audience-badge">${post.audience}</span>`;
  // Add to post template
}
```

---

## Testing Checklist

- [ ] Create post with no images (JSON) → works, backward compatible
- [ ] Create post with 1-4 images (multipart) → images saved and returned
- [ ] Create post with >4 images → 400 error
- [ ] Create post with non-image file → 400 error
- [ ] Create post with >5MB image → 400 error
- [ ] Create post with >1000 chars → 400 error
- [ ] Create post with empty content → 400 error
- [ ] Set audience to "Events" → persisted and returned
- [ ] Omit audience → defaults to "Academic"
- [ ] GET /api/posts → includes audience and images fields
- [ ] GET /api/posts?audience=Events → returns only Events posts
- [ ] GET /api/posts?audience=InvalidValue → 400 error
- [ ] Access image via /static/uploads/<filename> → serves file

---

## Files Modified

1. **app.py**
   - Added imports: `uuid`, `secure_filename` from werkzeug.utils
   - Added constants: `UPLOAD_FOLDER`, `ALLOWED_EXTENSIONS`, `MAX_IMAGE_SIZE`, `MAX_IMAGES_PER_POST`, `VALID_AUDIENCES`
   - Updated `init_db()`: added `audience` column, `post_images` table
   - Added route: `GET /static/uploads/<filename>`
   - Modified `POST /api/posts`: multipart support, validation, image handling
   - Modified `GET /api/posts`: added audience filtering, image fetching
   - Modified `row_to_post_dict()`: added `audience` and `images` fields

2. **beebo.db** (schema migration applied automatically on next run)
   - `posts.audience` column added
   - `post_images` table created

3. **static/uploads/** (directory created)
   - Stores uploaded images

---

## Notes

- **Drafts remain frontend-only** (localStorage). The backend does not store drafts.
- **Images are stored on disk** at `static/uploads/` with UUID filenames for uniqueness.
- **Backward compatibility**: JSON-only posts (no images) still work exactly as before.
- **No breaking changes**: Existing posts have `audience='Academic'` and `images=[]` by default.
- **File size validation** happens server-side even though frontend also enforces it.
- **Audience validation** is lenient: invalid values default to "Academic" rather than erroring (per requirements).

