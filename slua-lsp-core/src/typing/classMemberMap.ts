/** Class-building maps share immutable AVL nodes across ancestor snapshots.
 * Lookups/updates use O(log n) work; forks retain a root rather than all entries.
 * Iteration materializes one insertion-ordered view, never a per-class cache.
 * Mutating a builder cannot change a previously forked parent or child. */
type Node<V> = { readonly key: string; readonly value: V; readonly order: number; readonly left?: Node<V>; readonly right?: Node<V>; readonly height: number; readonly size: number };
const height = <V>(node?: Node<V>): number => node?.height ?? 0;
function node<V>(key: string, value: V, order: number, left?: Node<V>, right?: Node<V>): Node<V> {
	return { key, value, order, left, right, height: 1 + Math.max(height(left), height(right)), size: 1 + (left?.size ?? 0) + (right?.size ?? 0) };
}
function rotateLeft<V>(root: Node<V>): Node<V> {
	const next = root.right!;
	return node(next.key, next.value, next.order, node(root.key, root.value, root.order, root.left, next.left), next.right);
}
function rotateRight<V>(root: Node<V>): Node<V> {
	const next = root.left!;
	return node(next.key, next.value, next.order, next.left, node(root.key, root.value, root.order, next.right, root.right));
}
function balance<V>(root: Node<V>): Node<V> {
	if (height(root.left) - height(root.right) > 1) {
		if (height(root.left!.right) > height(root.left!.left)) root = node(root.key, root.value, root.order, rotateLeft(root.left!), root.right);
		return rotateRight(root);
	}
	if (height(root.right) - height(root.left) > 1) {
		if (height(root.right!.left) > height(root.right!.right)) root = node(root.key, root.value, root.order, root.left, rotateRight(root.right!));
		return rotateLeft(root);
	}
	return root;
}
function insert<V>(root: Node<V> | undefined, key: string, value: V, order: number): Node<V> {
	if (!root) return node(key, value, order);
	if (key === root.key) return root.value === value ? root : node(key, value, root.order, root.left, root.right);
	return balance(key < root.key ? node(root.key, root.value, root.order, insert(root.left, key, value, order), root.right)
		: node(root.key, root.value, root.order, root.left, insert(root.right, key, value, order)));
}
function remove<V>(root: Node<V> | undefined, key: string): Node<V> | undefined {
	if (!root) return undefined;
	if (key < root.key) return balance(node(root.key, root.value, root.order, remove(root.left, key), root.right));
	if (key > root.key) return balance(node(root.key, root.value, root.order, root.left, remove(root.right, key)));
	if (!root.left) return root.right;
	if (!root.right) return root.left;
	let successor = root.right;
	while (successor.left) successor = successor.left;
	return balance(node(successor.key, successor.value, successor.order, root.left, remove(root.right, successor.key)));
}
function find<V>(root: Node<V> | undefined, key: string): Node<V> | undefined {
	while (root && root.key !== key) root = key < root.key ? root.left : root.right;
	return root;
}
function ordered<V>(root?: Node<V>): Array<Node<V>> {
	const result: Array<Node<V>> = [], stack: Array<Node<V>> = root ? [root] : [];
	while (stack.length) { const entry = stack.pop()!; result.push(entry); if (entry.left) stack.push(entry.left); if (entry.right) stack.push(entry.right); }
	return result.sort((a, b) => a.order - b.order);
}
export class ClassMemberMap<V> implements ReadonlyMap<string, V> {
	private root?: Node<V>;
	private nextOrder = 0;
	fork(): ClassMemberMap<V> { const copy = new ClassMemberMap<V>(); copy.root = this.root; copy.nextOrder = this.nextOrder; return copy; }
	get size(): number { return this.root?.size ?? 0; }
	get(key: string): V | undefined { return find(this.root, key)?.value; }
	has(key: string): boolean { return !!find(this.root, key); }
	set(key: string, value: V): this { const exists = this.has(key); this.root = insert(this.root, key, value, this.nextOrder); if (!exists) this.nextOrder++; return this; }
	delete(key: string): boolean { if (!this.has(key)) return false; this.root = remove(this.root, key); return true; }
	*entries(): Generator<[string, V], undefined> { for (const entry of ordered(this.root)) yield [entry.key, entry.value] as [string, V]; return undefined; }
	*keys(): Generator<string, undefined> { for (const [key] of this) yield key; return undefined; }
	*values(): Generator<V, undefined> { for (const [, value] of this) yield value; return undefined; }
	[Symbol.iterator]() { return this.entries(); }
	forEach(callback: (value: V, key: string, map: ReadonlyMap<string, V>) => void, thisArg?: unknown): void { for (const [key, value] of this) callback.call(thisArg, value, key, this); }
}
export class ClassMemberSet {
	private members: ClassMemberMap<true>;
	constructor(members = new ClassMemberMap<true>()) { this.members = members; }
	fork(): ClassMemberSet { return new ClassMemberSet(this.members.fork()); }
	get size(): number { return this.members.size; }
	has(key: string): boolean { return this.members.has(key); }
	add(key: string): this { this.members.set(key, true); return this; }
	delete(key: string): boolean { return this.members.delete(key); }
	[Symbol.iterator]() { return this.members.keys(); }
}

/** Origin views defer enumeration and keep inherited lookup logarithmic. */
export function classOriginView<V>(fields: ReadonlyMap<string, V>, methods: ReadonlyMap<string, V>, allowed?: { has(key: string): boolean }): ReadonlyMap<string, V> {
	return {
		get size() { let size = 0; for (const _entry of this) size++; return size; },
		get(key) { return allowed && !allowed.has(key) ? undefined : methods.get(key) ?? fields.get(key); },
		has(key) { return (!allowed || allowed.has(key)) && (methods.has(key) || fields.has(key)); },
		*entries(): Generator<[string, V], undefined> {
			for (const [key, value] of fields) if (!allowed || allowed.has(key)) yield [key, methods.get(key) ?? value] as [string, V];
			for (const [key, value] of methods) if (!fields.has(key) && (!allowed || allowed.has(key))) yield [key, value] as [string, V];
			return undefined;
		},
		*keys(): Generator<string, undefined> { for (const [key] of this) yield key; return undefined; },
		*values(): Generator<V, undefined> { for (const [, value] of this) yield value; return undefined; },
		[Symbol.iterator]() { return this.entries(); },
		forEach(callback, thisArg) { for (const [key, value] of this) callback.call(thisArg, value, key, this); }
	};
}
