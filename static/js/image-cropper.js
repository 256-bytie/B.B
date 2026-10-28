// ---- Image cropper (templates/partials/image_cropper.html) ----
// openImageCropper(file, options) shows a full-screen crop step and resolves with the
// cropped image as a JPEG File, or null if the user cancels. It rejects if the file
// cannot be decoded as an image (the caller shows a toast).
//
// Options:
//   aspect     width / height to lock the crop box to (1 = square); null/omitted = free ratio
//   circle     true draws a circular guide inside the box (round avatars)
//   maxOutput  longest side of the output in px (default 1024; never upscaled)
//   title      heading text
//
// The box is moved by dragging inside it and resized by its handles: the four corners
// always, plus the four edge midpoints when the ratio is free. Rotate turns the photo
// 90 degrees clockwise. The crop is stored in source-image pixels, so it survives
// rotation, window resizes and screen rotation. Used by the profile picture upload
// (profile-own.js); nothing in here knows about uploads.

const IC_SOURCE_MAX = 4096; // longest side of the working copy, keeps memory sane for huge photos
const IC_MIN_DISPLAY = 56;  // smallest crop box edge on screen, in px
const IC_PAD = 16;          // gap between the photo and the stage edge, in px

let icSession = null;

function icEl(id) { return document.getElementById(id); }

function icLoadImage(file) {
	return new Promise(function (resolve, reject) {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
		img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
		img.src = url;
	});
}

// Working copy of the photo as a canvas (EXIF orientation is applied by drawImage).
function icSourceFromImage(img) {
	const w = img.naturalWidth, h = img.naturalHeight;
	if (!w || !h) throw new Error('Empty image');
	const k = Math.min(1, IC_SOURCE_MAX / Math.max(w, h));
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(w * k));
	canvas.height = Math.max(1, Math.round(h * k));
	canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas;
}

function icRotateCanvas(src) {
	const out = document.createElement('canvas');
	out.width = src.height;
	out.height = src.width;
	const ctx = out.getContext('2d');
	ctx.translate(out.width, 0);
	ctx.rotate(Math.PI / 2);
	ctx.drawImage(src, 0, 0);
	return out;
}

function openImageCropper(file, options) {
	const opts = options || {};
	return icLoadImage(file).then(function (img) {
		const source = icSourceFromImage(img);
		return new Promise(function (resolve) {
			icStart(file, source, opts, resolve);
		});
	});
}

function icStart(file, source, opts, resolve) {
	const overlay = icEl('image-cropper');
	const stage = icEl('ic-stage');
	const canvas = icEl('ic-canvas');
	const box = icEl('ic-box');
	const aspect = opts.aspect > 0 ? opts.aspect : null;

	icEl('ic-title').textContent = opts.title || 'Crop photo';
	icEl('ic-circle').style.display = opts.circle ? 'block' : 'none';
	// Edge handles only make sense when the ratio is free.
	box.querySelectorAll('.ic-h-n, .ic-h-s, .ic-h-w, .ic-h-e').forEach(function (h) {
		h.style.display = aspect ? 'none' : 'block';
	});

	const s = {
		source: source,
		aspect: aspect,
		crop: null,                 // {x, y, w, h} in source px
		view: { ox: 0, oy: 0, scale: 1 }, // photo's position and scale inside the stage
		drag: null,
		done: false
	};
	icSession = s;

	function initialCrop() {
		const sw = s.source.width, sh = s.source.height;
		let w, h;
		if (aspect) {
			w = Math.min(sw, sh * aspect);
			h = w / aspect;
		} else {
			w = sw; h = sh;
		}
		w *= 0.92; h *= 0.92;
		return { x: (sw - w) / 2, y: (sh - h) / 2, w: w, h: h };
	}

	function layout() {
		const rect = stage.getBoundingClientRect();
		const sw = s.source.width, sh = s.source.height;
		const scale = Math.min((rect.width - IC_PAD * 2) / sw, (rect.height - IC_PAD * 2) / sh);
		s.view = {
			scale: scale,
			ox: (rect.width - sw * scale) / 2,
			oy: (rect.height - sh * scale) / 2
		};
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
		canvas.style.left = s.view.ox + 'px';
		canvas.style.top = s.view.oy + 'px';
		canvas.style.width = cw + 'px';
		canvas.style.height = ch + 'px';
		canvas.width = Math.round(cw * dpr);
		canvas.height = Math.round(ch * dpr);
		const ctx = canvas.getContext('2d');
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(s.source, 0, 0, canvas.width, canvas.height);
		place();
	}

	// Position the crop box from the crop (source px) and the current view.
	function place() {
		const v = s.view, c = s.crop;
		box.style.left = (v.ox + c.x * v.scale) + 'px';
		box.style.top = (v.oy + c.y * v.scale) + 'px';
		box.style.width = (c.w * v.scale) + 'px';
		box.style.height = (c.h * v.scale) + 'px';
	}

	// Photo bounds in stage px.
	function bounds() {
		const v = s.view;
		return { l: v.ox, t: v.oy, r: v.ox + s.source.width * v.scale, b: v.oy + s.source.height * v.scale };
	}

	function setCropFromDisplay(l, t, w, h) {
		const v = s.view;
		s.crop = { x: (l - v.ox) / v.scale, y: (t - v.oy) / v.scale, w: w / v.scale, h: h / v.scale };
		place();
	}

	function displayCrop() {
		const v = s.view, c = s.crop;
		return { l: v.ox + c.x * v.scale, t: v.oy + c.y * v.scale, w: c.w * v.scale, h: c.h * v.scale };
	}

	function pointInStage(e) {
		const r = stage.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	function onPointerDown(e) {
		const handle = e.target.closest('[data-handle]');
		if (!handle && !e.target.closest('#ic-box')) return;
		e.preventDefault();
		const p = pointInStage(e);
		const d = displayCrop();
		s.drag = {
			id: e.pointerId,
			handle: handle ? handle.dataset.handle : null,
			start: p,
			box: d,
			// Where inside the handle the finger landed, so the corner follows the finger without jumping.
			grab: handle ? { x: p.x - cornerX(handle.dataset.handle, d), y: p.y - cornerY(handle.dataset.handle, d) } : { x: 0, y: 0 }
		};
		try { stage.setPointerCapture(e.pointerId); } catch (err) {}
	}

	function cornerX(h, d) { return h.indexOf('w') !== -1 ? d.l : h.indexOf('e') !== -1 ? d.l + d.w : d.l + d.w / 2; }
	function cornerY(h, d) { return h.indexOf('n') !== -1 ? d.t : h.indexOf('s') !== -1 ? d.t + d.h : d.t + d.h / 2; }

	function onPointerMove(e) {
		const drag = s.drag;
		if (!drag || e.pointerId !== drag.id) return;
		e.preventDefault();
		const p = pointInStage(e);
		const b = bounds();
		const d0 = drag.box;

		if (!drag.handle) { // move
			let l = d0.l + (p.x - drag.start.x);
			let t = d0.t + (p.y - drag.start.y);
			l = Math.max(b.l, Math.min(l, b.r - d0.w));
			t = Math.max(b.t, Math.min(t, b.b - d0.h));
			setCropFromDisplay(l, t, d0.w, d0.h);
			return;
		}

		const px = p.x - drag.grab.x, py = p.y - drag.grab.y; // where the dragged corner/edge wants to be
		const h = drag.handle;

		if (s.aspect) { // corner handles only; the opposite corner stays put
			const ax = h.indexOf('w') !== -1 ? d0.l + d0.w : d0.l;
			const ay = h.indexOf('n') !== -1 ? d0.t + d0.h : d0.t;
			const dirX = h.indexOf('w') !== -1 ? -1 : 1;
			const dirY = h.indexOf('n') !== -1 ? -1 : 1;
			const roomX = dirX > 0 ? b.r - ax : ax - b.l;
			const roomY = dirY > 0 ? b.b - ay : ay - b.t;
			const wantW = Math.max((px - ax) * dirX, (py - ay) * dirY * s.aspect);
			const maxW = Math.min(roomX, roomY * s.aspect);
			const minW = Math.min(IC_MIN_DISPLAY, maxW);
			const w = Math.max(minW, Math.min(wantW, maxW));
			const hh = w / s.aspect;
			setCropFromDisplay(dirX > 0 ? ax : ax - w, dirY > 0 ? ay : ay - hh, w, hh);
			return;
		}

		// Free ratio: each handle moves only its own edge(s).
		let l = d0.l, t = d0.t, r = d0.l + d0.w, bt = d0.t + d0.h;
		if (h.indexOf('w') !== -1) l = Math.max(b.l, Math.min(px, r - IC_MIN_DISPLAY));
		if (h.indexOf('e') !== -1) r = Math.min(b.r, Math.max(px, l + IC_MIN_DISPLAY));
		if (h.indexOf('n') !== -1) t = Math.max(b.t, Math.min(py, bt - IC_MIN_DISPLAY));
		if (h.indexOf('s') !== -1) bt = Math.min(b.b, Math.max(py, t + IC_MIN_DISPLAY));
		setCropFromDisplay(l, t, r - l, bt - t);
	}

	function onPointerUp(e) {
		if (s.drag && e.pointerId === s.drag.id) s.drag = null;
	}

	function rotate() {
		// Rotating the photo 90deg clockwise maps source point (x, y) to (H - y, x).
		const H = s.source.height, c = s.crop;
		s.source = icRotateCanvas(s.source);
		s.crop = { x: H - (c.y + c.h), y: c.x, w: c.h, h: c.w };
		if (s.aspect) { // keep the locked ratio exactly (w/h swapped by the rotation of a non-square box)
			s.crop = fitAspect(s.crop);
		}
		layout();
	}

	function fitAspect(c) {
		const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
		let w = c.w, h = c.w / s.aspect;
		if (h > s.source.height) { h = s.source.height; w = h * s.aspect; }
		if (w > s.source.width) { w = s.source.width; h = w / s.aspect; }
		const x = Math.max(0, Math.min(cx - w / 2, s.source.width - w));
		const y = Math.max(0, Math.min(cy - h / 2, s.source.height - h));
		return { x: x, y: y, w: w, h: h };
	}

	function finish(result) {
		if (s.done) return;
		s.done = true;
		stage.removeEventListener('pointerdown', onPointerDown);
		stage.removeEventListener('pointermove', onPointerMove);
		stage.removeEventListener('pointerup', onPointerUp);
		stage.removeEventListener('pointercancel', onPointerUp);
		icEl('ic-cancel').onclick = null;
		icEl('ic-done').onclick = null;
		icEl('ic-rotate').onclick = null;
		document.removeEventListener('keydown', onKey);
		window.removeEventListener('resize', onResize);
		overlay.hidden = true;
		document.body.style.overflow = s.prevOverflow || '';
		icSession = null;
		resolve(result);
	}

	function onKey(e) { if (e.key === 'Escape') finish(null); }
	function onResize() { layout(); }

	function exportCrop() {
		const c = s.crop;
		const max = opts.maxOutput > 0 ? opts.maxOutput : 1024;
		const k = Math.min(1, max / Math.max(c.w, c.h));
		const out = document.createElement('canvas');
		out.width = Math.max(1, Math.round(c.w * k));
		out.height = Math.max(1, Math.round(c.h * k));
		const ctx = out.getContext('2d');
		ctx.fillStyle = '#ffffff'; // JPEG has no transparency
		ctx.fillRect(0, 0, out.width, out.height);
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(s.source, c.x, c.y, c.w, c.h, 0, 0, out.width, out.height);
		out.toBlob(function (blob) {
			if (!blob) { finish(null); return; }
			const base = (file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
			finish(new File([blob], base + '.jpg', { type: 'image/jpeg' }));
		}, 'image/jpeg', 0.92);
	}

	s.prevOverflow = document.body.style.overflow;
	document.body.style.overflow = 'hidden';
	overlay.hidden = false;
	s.crop = initialCrop();
	layout();

	stage.addEventListener('pointerdown', onPointerDown);
	stage.addEventListener('pointermove', onPointerMove);
	stage.addEventListener('pointerup', onPointerUp);
	stage.addEventListener('pointercancel', onPointerUp);
	icEl('ic-cancel').onclick = function () { finish(null); };
	icEl('ic-done').onclick = exportCrop;
	icEl('ic-rotate').onclick = rotate;
	document.addEventListener('keydown', onKey);
	window.addEventListener('resize', onResize);
	overlay.focus(); // keyboard focus moves into the dialog (Escape works), without ringing a button
}
