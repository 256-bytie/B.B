# Backend Extension Summary

## What Changed

✅ **Schema**
- `posts` table: added `audience` column (TEXT, default 'Academic')
- New `post_images` table: stores image paths with post_id FK

✅ **POST /api/posts** 
- Accepts JSON (backward compatible) OR multipart/form-data
- New fields: `audience` (optional), `images` (File[], max 4)
- Validations: 1000 char limit, 4 image max, 5MB per image, image/* only

✅ **GET /api/posts**
- Returns new fields: `audience`, `images: []`
- New query param: `?audience=Academic|Events|etc` for filtering

✅ **GET /static/uploads/<filename>**
- Serves uploaded image files

✅ **All validation errors** follow existing `{'error': 'message'}` pattern

## Frontend Integration Needed

**Step 1:** Keep original `File` objects in `composeState.images`
```javascript
composeState.images = files.map(file => ({
  file: file,                        // Keep this!
  dataUrl: URL.createObjectURL(file), // For preview
  name: file.name
}));
```

**Step 2:** Switch POST to multipart
```javascript
const formData = new FormData();
formData.append('content', composeState.content);
formData.append('audience', composeState.audience);
composeState.images.forEach(img => formData.append('images', img.file));

await fetch('/api/posts', {
  method: 'POST',
  body: formData,  // No Content-Type header needed
  credentials: 'include'
});
```

**Step 3:** Render post images
```javascript
post.images.forEach(url => {
  // <img src="/static/uploads/abc123.png">
});
```

**Step 4:** Wire audience filters to top nav tabs
```javascript
await fetch(`/api/posts?audience=${audience}`);
```

## Error Messages to Handle

- `"Post exceeds 1000 character limit."`
- `"A post can have at most 4 images."`
- `"Only image files are supported."`
- `"Each image must be under 5MB."`

## No Breaking Changes

- JSON-only posts still work (backward compatible)
- Existing posts have `audience='Academic'`, `images=[]`
- All existing routes unchanged except POST/GET /api/posts
