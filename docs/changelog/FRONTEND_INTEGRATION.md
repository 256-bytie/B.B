# Frontend Integration Guide for beebo.html

This document shows the exact changes needed in `beebo.html` to integrate with the new backend API.

## Changes Required in beebo.html

### Change 1: Store File Objects (not just dataUrls)

**Find:** The code where files are processed from the file input (likely in image attachment handler)

**Current pattern (assumed):**
```javascript
// When files are selected
fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  
  // Read each as dataURL for preview
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      composeState.images.push({
        dataUrl: e.target.result,
        name: file.name
      });
    };
    reader.readAsDataURL(file);
  });
});
```

**Change to:**
```javascript
// When files are selected - keep the File object!
fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  
  // Store File object + create object URL for preview
  composeState.images = files.map(file => ({
    file: file,                          // Keep original File object
    dataUrl: URL.createObjectURL(file),  // For preview (more efficient than FileReader)
    name: file.name
  }));
  
  // Don't forget to update the UI with the new images
  updateImagePreview();
});

// Clean up object URLs when removing images
function removeImage(index) {
  if (composeState.images[index]?.dataUrl) {
    URL.revokeObjectURL(composeState.images[index].dataUrl);
  }
  composeState.images.splice(index, 1);
  updateImagePreview();
}
```

---

### Change 2: Update POST /api/posts to use FormData

**Find:** The function that submits the post (likely named `submitPost`, `createPost`, or similar)

**Current pattern (assumed):**
```javascript
async function submitPost() {
  try {
    const response = await fetch('/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: composeState.content
      }),
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create post');
    }

    const newPost = await response.json();
    // Handle success...
  } catch (error) {
    // Handle error...
  }
}
```

**Change to:**
```javascript
async function submitPost() {
  try {
    // Build FormData instead of JSON
    const formData = new FormData();
    formData.append('content', composeState.content);
    formData.append('audience', composeState.audience);

    // Append each image file
    if (composeState.images && composeState.images.length > 0) {
      composeState.images.forEach(img => {
        formData.append('images', img.file);
      });
    }

    const response = await fetch('/api/posts', {
      method: 'POST',
      // NO Content-Type header - browser sets it automatically with boundary
      body: formData,
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create post');
    }

    const newPost = await response.json();
    
    // Clean up object URLs
    composeState.images.forEach(img => {
      if (img.dataUrl) URL.revokeObjectURL(img.dataUrl);
    });
    
    // Clear compose state and close modal
    resetComposeState();
    closeComposeModal();
    
    // Refresh feed to show new post
    await loadPosts();
    
  } catch (error) {
    showError(error.message);
  }
}
```

---

### Change 3: Render Images in Post Cards

**Find:** The function that renders a post (likely `renderPost` or inside a template)

**Current pattern (assumed):**
```javascript
function renderPost(post) {
  return `
    <div class="post-card" data-post-id="${post.id}">
      <div class="post-header">
        <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${post.author_handle}" 
             class="avatar">
        <div class="post-author">
          <div class="author-name">${post.author_name}</div>
          <div class="author-handle">@${post.author_handle}</div>
        </div>
      </div>
      <div class="post-content">${escapeHtml(post.content)}</div>
      <div class="post-stats">
        <!-- likes, comments, etc -->
      </div>
    </div>
  `;
}
```

**Change to:**
```javascript
function renderPost(post) {
  // Render images if present
  let imagesHtml = '';
  if (post.images && post.images.length > 0) {
    const imageElements = post.images.map(url => `
      <img src="${url}" 
           alt="Post attachment" 
           class="post-image"
           loading="lazy">
    `).join('');
    
    // Use grid layout for multiple images
    const gridClass = post.images.length === 1 ? 'image-grid-single' :
                      post.images.length === 2 ? 'image-grid-two' :
                      post.images.length === 3 ? 'image-grid-three' :
                      'image-grid-four';
    
    imagesHtml = `<div class="post-images ${gridClass}">${imageElements}</div>`;
  }

  // Audience badge
  const audienceBadge = `
    <span class="audience-badge audience-${post.audience.toLowerCase()}">
      ${post.audience}
    </span>
  `;

  return `
    <div class="post-card" data-post-id="${post.id}">
      <div class="post-header">
        <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=${post.author_handle}" 
             class="avatar">
        <div class="post-author">
          <div class="author-name">${post.author_name}</div>
          <div class="author-handle">@${post.author_handle}</div>
        </div>
        ${audienceBadge}
      </div>
      <div class="post-content">${escapeHtml(post.content)}</div>
      ${imagesHtml}
      <div class="post-stats">
        <!-- likes, comments, etc -->
      </div>
    </div>
  `;
}
```

**Add CSS for image layouts:**
```css
.post-images {
  margin-top: 12px;
  border-radius: 12px;
  overflow: hidden;
  display: grid;
  gap: 2px;
}

.image-grid-single {
  grid-template-columns: 1fr;
}

.image-grid-two {
  grid-template-columns: 1fr 1fr;
}

.image-grid-three {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}

.image-grid-three .post-image:first-child {
  grid-row: 1 / 3;
}

.image-grid-four {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}

.post-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  max-height: 400px;
  cursor: pointer;
}

.audience-badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  margin-left: auto;
}

.audience-academic { background: #e3f2fd; color: #1976d2; }
.audience-announcements { background: #fff3e0; color: #f57c00; }
.audience-events { background: #f3e5f5; color: #7b1fa2; }
.audience-community { background: #e8f5e9; color: #388e3c; }
.audience-general { background: #f5f5f5; color: #616161; }
```

---

### Change 4: Wire Up Audience Filtering

**Find:** The top navigation tabs (For You, Announcements, Academic, Events, Community)

**Add data attributes to tabs (if not already present):**
```html
<nav class="feed-tabs">
  <button class="tab active" data-audience="for-you">For You</button>
  <button class="tab" data-audience="Announcements">Announcements</button>
  <button class="tab" data-audience="Academic">Academic</button>
  <button class="tab" data-audience="Events">Events</button>
  <button class="tab" data-audience="Community">Community</button>
</nav>
```

**Add event listeners:**
```javascript
// Initialize tab filtering
function initializeFeedTabs() {
  const tabs = document.querySelectorAll('.feed-tabs .tab');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Update active state
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Load filtered posts
      const audience = tab.dataset.audience;
      if (audience === 'for-you') {
        loadPosts(); // No filter
      } else {
        loadPosts(audience); // Filter by audience
      }
    });
  });
}

// Update loadPosts to accept filter parameter
async function loadPosts(audienceFilter = null) {
  try {
    const url = audienceFilter 
      ? `/api/posts?audience=${encodeURIComponent(audienceFilter)}`
      : '/api/posts';
    
    const response = await fetch(url, { credentials: 'include' });
    
    if (!response.ok) {
      throw new Error('Failed to load posts');
    }
    
    const posts = await response.json();
    renderPosts(posts);
    
  } catch (error) {
    console.error('Error loading posts:', error);
    showError('Failed to load posts');
  }
}

// Call on page load
document.addEventListener('DOMContentLoaded', () => {
  initializeFeedTabs();
  loadPosts();
});
```

---

## Error Handling

Update your error handler to display the new validation errors:

```javascript
function handlePostError(error) {
  const errorMessages = {
    'Post exceeds 1000 character limit.': 'Your post is too long. Please keep it under 1000 characters.',
    'A post can have at most 4 images.': 'You can only attach up to 4 images per post.',
    'Only image files are supported.': 'Please only attach image files (PNG, JPG, GIF, WebP).',
    'Each image must be under 5MB.': 'One or more images are too large. Please use images under 5MB.',
    'Authentication required': 'Please log in to create a post.'
  };
  
  const message = errorMessages[error.message] || error.message;
  showError(message);
}
```

---

## Testing Your Integration

After making these changes:

1. ✅ **Test posting without images** (should still work via JSON fallback)
2. ✅ **Test posting with 1-4 images** (should upload and display)
3. ✅ **Test posting with different audiences** (should save and display badge)
4. ✅ **Test clicking audience tabs** (should filter feed)
5. ✅ **Test validation errors**:
   - Try posting >1000 characters
   - Try uploading >4 images
   - Try uploading non-image file
   - Try uploading >5MB image (use test file)
6. ✅ **Verify images display in feed** after posting
7. ✅ **Verify audience badges display** on posts

---

## Optional: Add Image Lightbox

For better UX, add a click handler to view images full-screen:

```javascript
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('post-image')) {
    showImageLightbox(e.target.src);
  }
});

function showImageLightbox(imageUrl) {
  const lightbox = document.createElement('div');
  lightbox.className = 'image-lightbox';
  lightbox.innerHTML = `
    <div class="lightbox-backdrop"></div>
    <img src="${imageUrl}" class="lightbox-image">
    <button class="lightbox-close">&times;</button>
  `;
  
  lightbox.addEventListener('click', () => {
    lightbox.remove();
  });
  
  document.body.appendChild(lightbox);
}
```

```css
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.9);
}

.lightbox-image {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
}

.lightbox-close {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: white;
  font-size: 24px;
  cursor: pointer;
}
```

