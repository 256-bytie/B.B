"""Flask application factory."""
import os
import hmac
from flask import Flask, send_from_directory, request, jsonify, session, render_template
from flask_cors import CORS
from flask_session import Session


def create_app():
    """Create and configure the Flask application."""
    # Flask's root_path is used for resolving relative paths. When __name__ is 'app'
    # (this module's package name), Flask sets root_path to the app/ directory.
    # We need it to be the project root instead, so we explicitly set it.
    import os
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    app = Flask(__name__, root_path=project_root)
    CORS(app)

    # index.html assembles beebo's markup from templates/partials/*.html via
    # {% include %} (see templates/index.html). These flags are required for
    # that assembly to reproduce the original single-file output exactly
    # (no stray blank lines from the include tags themselves) — verified by
    # diffing render output against the pre-split beebo.html byte for byte.
    app.jinja_env.trim_blocks = True
    app.jinja_env.lstrip_blocks = True

    # Cache-busting for static JS/CSS: appends each file's on-disk mtime as
    # a query string (e.g. /static/js/feed.js?v=1758285000). Without this,
    # editing a static file doesn't change its URL, so browsers that have
    # it in cache keep serving the old copy after a deploy - the page has
    # to be hard-refreshed (cache disabled) to see the change at all. With
    # the mtime in the URL, a normal reload fetches the new file the
    # moment it's saved to disk, no manual cache-busting or hard refresh
    # required.
    @app.context_processor
    def inject_static_version():
        def static_v(rel_path):
            abs_path = os.path.join(app.root_path, 'static', rel_path.lstrip('/'))
            try:
                v = int(os.path.getmtime(abs_path))
            except OSError:
                v = 0
            return f'/static/{rel_path.lstrip("/")}?v={v}'
        return dict(static_v=static_v)

    # Load or generate persistent secret key
    SECRET_KEY_FILE = '.flask_secret_key'
    if os.environ.get('SECRET_KEY'):
        app.secret_key = os.environ['SECRET_KEY']
    elif os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, 'rb') as f:
            app.secret_key = f.read()
    else:
        app.secret_key = os.urandom(24)
        with open(SECRET_KEY_FILE, 'wb') as f:
            f.write(app.secret_key)

    # Configure server-side sessions
    app.config['SESSION_TYPE'] = 'filesystem'
    app.config['SESSION_FILE_DIR'] = './flask_session'
    app.config['SESSION_PERMANENT'] = False
    app.config['SESSION_USE_SIGNER'] = True
    Session(app)

    # Set maximum upload size (50MB) - raised for library file uploads
    app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

    # Print database path
    from app.db import get_db_path
    print(f"[beebo] Using database: {get_db_path()}")

    # Ensure upload directory exists
    UPLOAD_FOLDER = 'static/uploads'
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)

    # Register blueprints
    from app.routes import auth, posts, users, library, search, wallet
    app.register_blueprint(auth.bp)
    app.register_blueprint(posts.bp)
    app.register_blueprint(users.bp)
    app.register_blueprint(library.bp)
    app.register_blueprint(search.bp)
    app.register_blueprint(wallet.bp)

    # CSRF protection: validate token on mutating requests
    @app.before_request
    def csrf_protect():
        """Validate CSRF token on mutating requests.

        Exempt /api/login and /api/signup (no session-held token exists yet).
        All other POST/PATCH/PUT/DELETE requests must carry a valid token
        in the X-CSRF-Token header that matches session['csrf_token'].
        """
        if request.method in ('POST', 'PATCH', 'PUT', 'DELETE'):
            # Exempt login and signup
            if request.path in ('/api/login', '/api/signup'):
                return None

            # Check for token in header
            token_from_header = request.headers.get('X-CSRF-Token')
            token_from_session = session.get('csrf_token')

            if not token_from_header or not token_from_session:
                return jsonify({'error': 'Invalid CSRF token'}), 403

            # Use constant-time comparison
            if not hmac.compare_digest(token_from_header, token_from_session):
                return jsonify({'error': 'Invalid CSRF token'}), 403

        return None

    # Static file routes
    # index.html is a Jinja template that includes templates/partials/*.html
    # (one file per view/overlay) — the SPA itself is still plain client-side
    # JS (view switching, routing) exactly as before. Splitting the markup
    # only changes how the same output is authored/maintained, not what's
    # sent to the browser.
    @app.route('/')
    def index():
        """Serve the main HTML file"""
        return render_template('index.html')

    @app.route('/profile')
    def profile_page():
        return render_template('index.html')

    @app.route('/u/<int:user_id>')
    def user_profile_page(user_id):
        return render_template('index.html')

    @app.route('/static/uploads/<path:filename>')
    def uploaded_file(filename):
        """Serve uploaded image files"""
        return send_from_directory(UPLOAD_FOLDER, filename)

    return app
