rows = db.execute("SELECT * FROM t WHERE id = :id", {"id": uid})
