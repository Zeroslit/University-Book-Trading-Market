[English](./06-multi-school-isolation.md) | [简体中文](../06-多校隔离实现说明.md)

# 06 Multi-school isolation

## 1. Goal
No read or write may ever touch another school's data; cross-school access by platform roles (support / platform admin) must be **explicitly authorized and audited**.

## 2. Three layers of protection

### 2.1 Middleware: `middleware/school-scope.js`
```js
// Pseudocode (see the source for the implementation)
export function schoolScope(req, res, next) {
  // 1) Students: the school comes from the session; whatever the client sends is ignored
  if (req.user && CROSS_SCHOOL_ROLES.includes(req.user.role) === false) {
    req.schoolId = req.user.schoolId;
    if (!req.schoolId) throw new AppError(ERR.SCHOOL_REQUIRED);
    return next();
  }
  // 2) Support / platform admins: schoolId is mandatory, permissions are checked and an audit entry is written
  const sid = Number(req.query.schoolId || req.body.schoolId || req.params.schoolId);
  if (!sid) throw new AppError(ERR.SCHOOL_REQUIRED, 'cross-school roles must pass schoolId explicitly');
  req.schoolId = sid;
  auditService.record({ actorId: req.user.id, action: 'cross_school_access', targetType: 'school', targetId: sid, ip: req.ip });
  next();
}
```
Key points:
- **The student side never accepts a client-supplied `schoolId`** (tampered payloads cannot escalate); it always comes from the JWT.
- Cross-school roles must pass `schoolId` explicitly, which is written to `audit_logs`.
- The middleware is mounted in front of all business routes except `/auth` and `/schools` (public lookups).

### 2.2 Data access layer: repositories require schoolId
```js
// Every repository method requires schoolId and throws immediately when it is missing
export async function findBookById(conn, schoolId, id) {
  assertSchoolId(schoolId);
  const [rows] = await conn.query(
    'SELECT * FROM books WHERE id = ? AND school_id = ? AND deleted_at IS NULL',
    [id, schoolId],
  );
  return rows[0] ?? null;
}
```
- `school_id = ?` is a **mandatory condition** in SQL, and `school_id` is indexed at the same priority as the primary key.
- Objects referenced across modules (such as `book_id` inside an order) are checked once more in the service layer with `assertSameSchool(book, req.schoolId)` as a second safety net.
- Platform-wide shared data (word library, knowledge base, configuration) uses an explicit exception, `school_id IS NULL OR school_id = ?`, wrapped centrally in `scopeSql()` so it never leaks across the codebase.

### 2.3 Database layer
- Composite unique keys encode the school dimension into constraints: `users(school_id, student_no)`, `banned_words(word, scope, school_id)`, `configs(scope, school_id, config_key)`.
- The composite index `(school_id, status, created_at)` keeps own-school list queries fully inside the index.

## 3. Cross-school zone
- Switches: `schools.cross_school_enabled` + `schools.cross_school_mode` (`off` disabled / `mail` mail delivery only).
- When enabled, the book list gains a "cross-school" filter and the query becomes `(school_id = ? OR (cross_school = 1))`; cross-school orders may only be shipped by mail.
- Off by default: of the three seeded schools only one has it enabled, which is what proves that there is no access by default.

## 4. How the blocking is verified
`server/tests/integration/isolation.test.js`:
1. A student from school A reads a book detail from school B → expects `404` (not 403, so existence is not leaked).
2. A student from school A requests the list with `?schoolId=B` → still returns school A data (the parameter is ignored).
3. A student from school A orders using a school B book ID → expects `BOOK_NOT_FOUND`.
4. A school admin only sees their own school's report and verification queues.
5. Support without `schoolId` → expects `SCHOOL_REQUIRED`.

## 5. Common pitfalls and how they are avoided
- **Writes must be filtered too**: `UPDATE books SET ... WHERE id = ? AND school_id = ?`, checking `affectedRows` so a request can never "read from one school and write to another".
- **Joined queries**: both sides of a JOIN carry a `school_id` condition, preventing cross-school user lookups through a `book_id`.
- **Cache keys must include schoolId**: `cfg:{schoolId}:{key}`, `book:detail:{schoolId}:{id}`, avoiding cache-based privilege escalation.
- **Export and statistics endpoints**: platform-wide statistics go through dedicated `admin` routes and purpose-built SQL instead of reusing student-facing repositories.
