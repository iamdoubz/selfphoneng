# 0002 — `pg` driver and `@fastify/cookie`

drizzle needs a PostgreSQL driver. We use `pg` (node-postgres): the most used Node driver, and the
one drizzle's docs and migrator target first. `@fastify/cookie` reads and sets the `sp_session`
cookie (04 §2.2); spec 04 §1 already names a cookie plugin but 00 §4 did not list it.
