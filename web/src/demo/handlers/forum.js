// 演示版：校园论坛（求书帖 / 转让帖 / 评论回复）与私信
import { table, insert, filter, nowIso } from '../store.js';
import { AppError, ERR } from '../vendor.js';
import { notify } from '../rules.js';
import { enforce as wordEnforce } from '../words.js';
import {
  paged, pageOf, slicePage, requireVerified, requirePublishPermission, requireTradePermission,
} from './util.js';

function authorOf(id) {
  return table('users').find((u) => Number(u.id) === Number(id)) || {};
}

function coverOf(threadId) {
  const image = filter('thread_images', (i) => Number(i.thread_id) === Number(threadId)).sort((a, b) => a.sort_order - b.sort_order)[0];
  return image ? image.url : null;
}

export function registerForumRoutes(route) {
  // ---------------- 帖子 ----------------
  route('GET', '/threads', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    let rows = filter('threads', (t) => Number(t.school_id) === Number(ctx.schoolId)
      && t.status === 'published' && !t.deleted_at);
    if (ctx.query.type) rows = rows.filter((t) => t.type === ctx.query.type);
    if (ctx.query.category) rows = rows.filter((t) => t.category === ctx.query.category);
    if (ctx.query.keyword) {
      const kw = String(ctx.query.keyword);
      rows = rows.filter((t) => String(t.title).includes(kw) || String(t.content).includes(kw));
    }
    rows = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
    const list = slicePage(rows, page, pageSize).map((t) => {
      const author = authorOf(t.author_id);
      return {
        id: Number(t.id), type: t.type, title: t.title, category: t.category,
        view_count: Number(t.view_count), reply_count: Number(t.reply_count), created_at: t.created_at,
        author_id: Number(t.author_id), author_nickname: author.nickname,
        author_credit: Number(author.credit_score || 0), cover_url: coverOf(t.id),
      };
    });
    return paged(list, rows.length, page, pageSize);
  });

  route('GET', '/threads/:id', (ctx) => {
    const thread = table('threads').find((t) => Number(t.id) === Number(ctx.params.id)
      && Number(t.school_id) === Number(ctx.schoolId) && !t.deleted_at);
    if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在或不属于本校');
    const author = authorOf(thread.author_id);
    const images = filter('thread_images', (i) => Number(i.thread_id) === Number(thread.id))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({ url: i.url }));
    const replies = filter('replies', (r) => Number(r.thread_id) === Number(thread.id)
      && Number(r.school_id) === Number(ctx.schoolId) && !r.deleted_at && r.status === 'published')
      .sort((a, b) => Number(a.floor_no) - Number(b.floor_no))
      .slice(0, 200)
      .map((r) => {
        const ra = authorOf(r.author_id);
        return {
          id: Number(r.id), parent_id: r.parent_id, floor_no: Number(r.floor_no), content: r.content,
          status: r.status, created_at: r.created_at, author_id: Number(r.author_id),
          author_nickname: ra.nickname, author_credit: Number(ra.credit_score || 0),
        };
      });
    thread.view_count = Number(thread.view_count || 0) + 1;
    return {
      ...thread,
      school_id: Number(thread.school_id), author_id: Number(thread.author_id),
      view_count: Number(thread.view_count), reply_count: Number(thread.reply_count),
      author_nickname: author.nickname, author_credit: Number(author.credit_score || 0),
      author_verified: author.verification_status,
      images, replies,
      isMine: Number(thread.author_id) === Number(ctx.user.id),
    };
  });

  route('POST', '/threads', (ctx) => {
    requireVerified(ctx);
    requirePublishPermission(ctx);
    const body = ctx.body;
    if (!['seek', 'sell'].includes(body.type)) throw new AppError(ERR.VALIDATION_ERROR, '帖子类型不正确');
    if (!body.title || String(body.title).length < 4) throw new AppError(ERR.VALIDATION_ERROR, '标题至少 4 个字');
    if (!body.content || String(body.content).length < 4) throw new AppError(ERR.VALIDATION_ERROR, '内容至少 4 个字');
    if (Array.isArray(body.images) && body.images.length > 9) throw new AppError(ERR.VALIDATION_ERROR, '图片最多 9 张');

    const decision = wordEnforce({
      schoolId: ctx.schoolId, userId: ctx.user.id, scene: 'thread', targetType: 'thread',
      text: `${body.title}\n${body.content}`,
    });
    const thread = insert('threads', {
      school_id: Number(ctx.schoolId), author_id: Number(ctx.user.id), type: body.type,
      title: body.title, content: body.content, category: body.category ?? null, status: 'published',
      view_count: 0, reply_count: 0, word_hit_level: decision.level, created_at: nowIso(),
      updated_at: nowIso(), deleted_at: null,
    });
    (body.images || []).forEach((url, i) => {
      insert('thread_images', { thread_id: Number(thread.id), school_id: Number(ctx.schoolId), url, sort_order: i + 1, created_at: nowIso() });
    });
    return { threadId: Number(thread.id), wordHits: decision.hits.map((h) => ({ word: h.word, level: h.level })) };
  }, { message: '发布成功' });

  route('PATCH', '/threads/:id', (ctx) => {
    const thread = table('threads').find((t) => Number(t.id) === Number(ctx.params.id)
      && Number(t.school_id) === Number(ctx.schoolId) && !t.deleted_at);
    if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在');
    if (Number(thread.author_id) !== Number(ctx.user.id)) throw new AppError(ERR.FORBIDDEN, '只能编辑自己的帖子');
    const decision = wordEnforce({
      schoolId: ctx.schoolId, userId: ctx.user.id, scene: 'thread', targetType: 'thread', targetId: thread.id,
      text: `${ctx.body.title ?? thread.title}\n${ctx.body.content ?? thread.content}`,
    });
    if (ctx.body.title !== undefined) thread.title = ctx.body.title;
    if (ctx.body.content !== undefined) thread.content = ctx.body.content;
    thread.word_hit_level = decision.level;
    thread.updated_at = nowIso();
    return { threadId: Number(thread.id), updated: true };
  });

  route('DELETE', '/threads/:id', (ctx) => {
    const thread = table('threads').find((t) => Number(t.id) === Number(ctx.params.id)
      && Number(t.school_id) === Number(ctx.schoolId) && !t.deleted_at);
    if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在');
    const isOwner = Number(thread.author_id) === Number(ctx.user.id);
    const isModerator = ['school_admin', 'support', 'platform_admin'].includes(ctx.user.role);
    if (!isOwner && !isModerator) throw new AppError(ERR.FORBIDDEN, '无权删除该帖子');
    thread.status = 'deleted';
    thread.deleted_at = nowIso();
    return { threadId: Number(thread.id), deleted: true };
  }, { message: '已删除' });

  // ---------------- 评论 / 楼中楼 ----------------
  route('POST', '/threads/:id/replies', (ctx) => {
    requireVerified(ctx);
    requirePublishPermission(ctx);
    const thread = table('threads').find((t) => Number(t.id) === Number(ctx.params.id)
      && Number(t.school_id) === Number(ctx.schoolId) && t.status === 'published' && !t.deleted_at);
    if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在或已关闭');
    const content = ctx.body.content;
    if (!content || String(content).length < 1) throw new AppError(ERR.VALIDATION_ERROR, '评论内容不能为空');
    if (ctx.body.parentId) {
      const parent = table('replies').find((r) => Number(r.id) === Number(ctx.body.parentId)
        && Number(r.thread_id) === Number(thread.id) && Number(r.school_id) === Number(ctx.schoolId));
      if (!parent) throw new AppError(ERR.NOT_FOUND, '回复的目标评论不存在');
    }
    const decision = wordEnforce({
      schoolId: ctx.schoolId, userId: ctx.user.id, scene: 'reply', targetType: 'thread', targetId: thread.id, text: String(content),
    });
    const nextFloor = filter('replies', (r) => Number(r.thread_id) === Number(thread.id))
      .reduce((max, r) => Math.max(max, Number(r.floor_no) || 0), 0) + 1;
    const reply = insert('replies', {
      school_id: Number(ctx.schoolId), thread_id: Number(thread.id), author_id: Number(ctx.user.id),
      parent_id: ctx.body.parentId ?? null, floor_no: nextFloor, content: decision.text,
      status: 'published', created_at: nowIso(), updated_at: nowIso(), deleted_at: null,
    });
    thread.reply_count = Number(thread.reply_count || 0) + 1;

    if (Number(thread.author_id) !== Number(ctx.user.id)) {
      notify(thread.author_id, {
        schoolId: Number(ctx.schoolId), type: 'thread', title: '你的帖子有新评论',
        content: `${ctx.user.nickname} 回复了《${thread.title}》：${String(decision.text).slice(0, 60)}`,
        relatedType: 'thread', relatedId: thread.id,
      });
    }
    return { replyId: Number(reply.id), floorNo: nextFloor };
  }, { message: '评论成功' });

  route('DELETE', '/replies/:id', (ctx) => {
    const reply = table('replies').find((r) => Number(r.id) === Number(ctx.params.id)
      && Number(r.school_id) === Number(ctx.schoolId) && !r.deleted_at);
    if (!reply) throw new AppError(ERR.NOT_FOUND, '评论不存在');
    const isOwner = Number(reply.author_id) === Number(ctx.user.id);
    const isModerator = ['school_admin', 'support', 'platform_admin'].includes(ctx.user.role);
    if (!isOwner && !isModerator) throw new AppError(ERR.FORBIDDEN, '无权删除该评论');
    reply.status = 'deleted';
    reply.deleted_at = nowIso();
    const thread = table('threads').find((t) => Number(t.id) === Number(reply.thread_id));
    if (thread) thread.reply_count = Math.max(0, Number(thread.reply_count || 0) - 1);
    return { replyId: Number(reply.id), deleted: true };
  }, { message: '已删除' });

  // ---------------- 私信 ----------------
  route('GET', '/conversations', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    const me = Number(ctx.user.id);
    const rows = table('conversations')
      .filter((c) => Number(c.school_id) === Number(ctx.schoolId) && (Number(c.buyer_id) === me || Number(c.seller_id) === me))
      .sort((a, b) => new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at));
    const list = slicePage(rows, page, pageSize).map((c) => {
      const peerId = Number(c.buyer_id) === me ? Number(c.seller_id) : Number(c.buyer_id);
      const peer = authorOf(peerId);
      const unread = filter('messages', (m) => Number(m.conversation_id) === Number(c.id)
        && Number(m.receiver_id) === me && !Number(m.is_read)).length;
      return {
        id: Number(c.id), book_id: c.book_id, thread_id: c.thread_id,
        last_message_at: c.last_message_at, last_message_preview: c.last_message_preview,
        status: c.status, peer_id: peerId, peer_nickname: peer.nickname,
        peer_credit: Number(peer.credit_score || 0), unread,
      };
    });
    return paged(list, rows.length, page, pageSize);
  });

  route('POST', '/conversations', (ctx) => {
    requireTradePermission(ctx);
    const { bookId, threadId } = ctx.body;
    if (!bookId && !threadId) throw new AppError(ERR.VALIDATION_ERROR, '必须关联图书或帖子');
    let ownerId = ctx.body.targetUserId ?? null;
    if (bookId) {
      const book = table('books').find((b) => Number(b.id) === Number(bookId)
        && Number(b.school_id) === Number(ctx.schoolId) && !b.deleted_at);
      if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在或不属于本校');
      ownerId = book.seller_id;
    } else if (threadId) {
      const thread = table('threads').find((t) => Number(t.id) === Number(threadId)
        && Number(t.school_id) === Number(ctx.schoolId) && !t.deleted_at);
      if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在或不属于本校');
      ownerId = thread.author_id;
    }
    if (!ownerId) throw new AppError(ERR.VALIDATION_ERROR, '缺少沟通对象');
    if (Number(ownerId) === Number(ctx.user.id)) throw new AppError(ERR.VALIDATION_ERROR, '不能和自己发起会话');

    const lo = Math.min(Number(ctx.user.id), Number(ownerId));
    const hi = Math.max(Number(ctx.user.id), Number(ownerId));
    const contextKey = `${lo}-${hi}-${bookId || 0}-${threadId || 0}`;
    const existed = table('conversations').find((c) => Number(c.school_id) === Number(ctx.schoolId) && c.context_key === contextKey);
    if (existed) return { conversationId: Number(existed.id), reused: true };

    const conversation = insert('conversations', {
      school_id: Number(ctx.schoolId), buyer_id: Number(ctx.user.id), seller_id: Number(ownerId),
      book_id: bookId ?? null, thread_id: threadId ?? null, context_key: contextKey,
      last_message_at: null, last_message_preview: null, status: 'active',
      created_at: nowIso(), updated_at: nowIso(),
    });
    return { conversationId: Number(conversation.id), reused: false };
  }, { message: '会话已创建' });

  route('GET', '/conversations/:id/messages', (ctx) => {
    const conversation = table('conversations').find((c) => Number(c.id) === Number(ctx.params.id)
      && Number(c.school_id) === Number(ctx.schoolId));
    if (!conversation) throw new AppError(ERR.NOT_FOUND, '会话不存在');
    const members = [Number(conversation.buyer_id), Number(conversation.seller_id)];
    if (!members.includes(Number(ctx.user.id))) throw new AppError(ERR.FORBIDDEN, '你不在该会话中');
    const { page, pageSize } = pageOf(ctx.query, { defaultSize: 50, maxSize: 200 });
    const rows = filter('messages', (m) => Number(m.conversation_id) === Number(conversation.id) && m.status !== 'deleted')
      .sort((a, b) => Number(b.id) - Number(a.id));
    const pageRows = slicePage(rows, page, pageSize).reverse().map((m) => ({
      id: Number(m.id), sender_id: Number(m.sender_id), receiver_id: Number(m.receiver_id),
      content: m.content, image_url: m.image_url, is_read: Number(m.is_read),
      read_at: m.read_at, created_at: m.created_at,
    }));
    for (const m of rows) {
      if (Number(m.receiver_id) === Number(ctx.user.id) && !Number(m.is_read)) {
        m.is_read = 1;
        m.read_at = nowIso();
      }
    }
    return { list: pageRows, page, pageSize };
  });

  route('POST', '/conversations/:id/messages', (ctx) => {
    requirePublishPermission(ctx);
    const conversation = table('conversations').find((c) => Number(c.id) === Number(ctx.params.id)
      && Number(c.school_id) === Number(ctx.schoolId));
    if (!conversation) throw new AppError(ERR.NOT_FOUND, '会话不存在');
    const members = [Number(conversation.buyer_id), Number(conversation.seller_id)];
    if (!members.includes(Number(ctx.user.id))) throw new AppError(ERR.FORBIDDEN, '你不在该会话中');
    if (!ctx.body.content && !ctx.body.imageUrl) throw new AppError(ERR.VALIDATION_ERROR, '消息内容不能为空');

    const receiverId = Number(conversation.buyer_id) === Number(ctx.user.id) ? conversation.seller_id : conversation.buyer_id;
    let content = ctx.body.content ?? null;
    let decision = { hits: [], level: null, text: content };
    if (content) {
      decision = wordEnforce({
        schoolId: ctx.schoolId, userId: ctx.user.id, scene: 'message',
        targetType: 'conversation', targetId: conversation.id, text: content,
      });
      content = decision.text;
    }
    const message = insert('messages', {
      school_id: Number(ctx.schoolId), conversation_id: Number(conversation.id),
      sender_id: Number(ctx.user.id), receiver_id: Number(receiverId), content,
      image_url: ctx.body.imageUrl ?? null, is_read: 0, read_at: null,
      word_hit_level: decision.level, status: 'sent', created_at: nowIso(),
    });
    conversation.last_message_at = nowIso();
    conversation.last_message_preview = (content || '[图片]').slice(0, 200);
    conversation.updated_at = nowIso();

    notify(receiverId, {
      schoolId: Number(ctx.schoolId), type: 'message', title: '你有一条新私信',
      content: (content || '[图片]').slice(0, 100), relatedType: 'conversation', relatedId: conversation.id,
    });
    return { messageId: Number(message.id), wordHits: decision.hits.map((h) => ({ word: h.word, level: h.level })) };
  }, { message: '已发送' });
}

export { authorOf };
