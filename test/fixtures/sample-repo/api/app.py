"""Flask API of the sample repo."""
from flask import Flask, jsonify

from .db import db

app = Flask(__name__)


@app.route('/api/items', methods=['GET'])
def list_items():
    """Return every item from the items table."""
    rows = db.execute('SELECT * FROM items')
    return jsonify(rows)


class ItemStore:
    """In-memory store used by the tests."""

    def add(self, item):
        """Append an item and return its index."""
        self.items.append(item)
        return len(self.items) - 1


# Build the store once at import time.
def make_store():
    return ItemStore()
