"""Wallet routes: credit balance, monthly free credits, and transaction history.

Top-ups are intentionally NOT implemented here: taking payment needs a
payment provider, and granting credits without one would be misleading.
The UI's Top Up button shows "Coming soon" until that exists. The ledger
already supports top-up entries (kind 'top_up'), so adding it later is a
new endpoint that calls wallet.record_transaction, not a schema change.
"""
from flask import Blueprint, request, jsonify, session
from app.db import get_db
from app import wallet
from app.serializers import serialize_credit_transaction, serialize_monthly_reward

bp = Blueprint('wallet', __name__)


def _json(payload, status=200):
    """JSON response that browsers must not cache: balances have to be
    fresh on every open of the Wallet screen and after a refresh."""
    response = jsonify(payload)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


@bp.route('/api/wallet', methods=['GET'])
def get_wallet():
    """Current user's balance and monthly-reward status."""
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    conn = get_db()
    try:
        user_id = session['user_id']
        return _json({
            'balance': wallet.get_balance(conn, user_id),
            'monthly_reward': serialize_monthly_reward(
                wallet.get_monthly_reward_status(conn, user_id)
            ),
        })
    finally:
        conn.close()


@bp.route('/api/wallet/transactions', methods=['GET'])
def get_wallet_transactions():
    """Newest-first, keyset-paginated transaction history.

    ?limit= clamps silently to [1, 50] (default 20); ?cursor=<id> returns
    entries older than that id. Response: {transactions, next_cursor}.
    """
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    try:
        limit = int(request.args.get('limit', wallet.DEFAULT_TX_LIMIT))
    except (TypeError, ValueError):
        limit = wallet.DEFAULT_TX_LIMIT

    cursor_arg = request.args.get('cursor')
    before_id = None
    if cursor_arg not in (None, ''):
        try:
            before_id = int(cursor_arg)
        except (TypeError, ValueError):
            return _json({'error': 'Invalid cursor'}, 400)

    conn = get_db()
    try:
        rows, next_cursor = wallet.list_transactions(
            conn, session['user_id'], limit=limit, before_id=before_id
        )
        return _json({
            'transactions': [serialize_credit_transaction(r) for r in rows],
            'next_cursor': next_cursor,
        })
    finally:
        conn.close()


@bp.route('/api/wallet/claim', methods=['POST'])
def claim_monthly_credits():
    """Claim this month's free credits (once per month per user)."""
    if 'user_id' not in session:
        return _json({'error': 'Authentication required'}, 401)

    user_id = session['user_id']
    conn = get_db()
    try:
        try:
            transaction_id = wallet.claim_monthly_reward(conn, user_id)
        except wallet.AlreadyClaimedError:
            # Include the fresh state so a client that was showing a stale
            # "Claim" button (second tab, day rollover) can correct itself.
            return _json({
                'error': 'Monthly credits already claimed',
                'monthly_reward': serialize_monthly_reward(
                    wallet.get_monthly_reward_status(conn, user_id)
                ),
                'balance': wallet.get_balance(conn, user_id),
            }, 409)

        return _json({
            'success': True,
            'balance': wallet.get_balance(conn, user_id),
            'monthly_reward': serialize_monthly_reward(
                wallet.get_monthly_reward_status(conn, user_id)
            ),
            'transaction': serialize_credit_transaction(
                wallet.get_transaction(conn, user_id, transaction_id)
            ),
        }, 201)
    finally:
        conn.close()
