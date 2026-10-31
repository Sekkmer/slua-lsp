import { describe, expect, test } from 'vitest';

import { parseSlua, buildSluaRegistryFromLslDefinitions, inferLocalVariableTypes, sluaTypeToString } from '../src/index.js';

describe('inferLocalVariableTypes', () => {
	test('infers simple literal types', () => {
		const code = `
			local a = 1
			local b = "hi"
			local c = true
			local d = nil
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('a')).toBe('number');
		expect(map.get('b')).toBe('string');
		expect(map.get('c')).toBe('boolean');
		// nil inlays are intentionally suppressed at the server layer, but inference should still know it.
		expect(map.get('d')).toBe('nil');
	});

	test('handles Lua multi-return assignment shape', () => {
		const code = `
			local function f()
				return 1, "s"
			end
			local x, y, z = f()
			local p, q = 123, f()
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('x')).toBe('number');
		expect(map.get('y')).toBe('string');
		expect(map.get('z')).toBe('nil');
		// Only last RHS expands: p gets 123, q gets first return of f().
		expect(map.get('p')).toBe('number');
		expect(map.get('q')).toBe('number');
	});

	test('infers multi-return count even when types are unknown', () => {
		const code = `
			local f = function(a, b)
				return a, b
			end
			local x, y, z = f(1, "s")
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		// We don't know the types of x/y (and unknown locals are intentionally omitted from results),
		// but we still know f returns 2 values, so the 3rd assignment slot becomes nil.
		expect(map.get('x')).toBeUndefined();
		expect(map.get('y')).toBeUndefined();
		expect(map.get('z')).toBe('nil');
	});

	test('infers common operators', () => {
		const code = `
			local t = {}
			local n = #t
			local s = "a" .. "b"
			local b = not false
			local m = -1
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('n')).toBe('number');
		expect(map.get('s')).toBe('string');
		expect(map.get('b')).toBe('boolean');
		expect(map.get('m')).toBe('number');
	});

	test('infers if-expression branch types', () => {
		const code = `
			local a = if true then "yes" else "no"
			local b = if true then integer.maxsigned else "no"
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('a')).toBe('string');
		expect(map.get('b')).toBe('integer | string');
	});

	test('infers Luau type casts from annotations', () => {
		const code = `
			local x = value :: integer
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('x')).toBe('integer');
	});

	test('does not infer shadowed generic for variables from outer locals', () => {
		const code = `
			local item: string = "outer"
			local list = {}
			local function f()
				for _, item in pairs(list) do
					return item
				end
			end
			local out = f()
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('out')).toBeUndefined();
	});

	test('infers registry-backed call return types', () => {
		const code = `
			local id = uuid("00000000-0000-0000-0000-000000000000")
			local decoded = lljson.decode("{}")
			local names = LLEvents:eventNames()
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('id')).toBe('uuid');
		// JSON may decode to a primitive; unknown results are omitted from inlays.
		expect(map.get('decoded')).toBeUndefined();
		expect(map.get('names')).toBe('string[]');
	});

	test('infers indexed access for known module functions', () => {
		const code = `
			local dec = lljson["decode"]
			local out = dec("{}")
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		// dec is a function value; a decoded JSON value has no guaranteed table type.
		expect(map.get('dec')).toBe('(string, [function | table]) -> unknown');
		expect(map.get('out')).toBeUndefined();
	});

	test('narrows typeof(x) == "number" within if branch', () => {
		const code = `
			local function foo()
				return nil
			end
			local x = foo()
			if typeof(x) == "number" then
				local y = x + 1
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		// y is inferred as number due to control-flow narrowing of x in the then-branch.
		expect(map.get('y')).toBe('number');
	});

	test('narrows within typeof guard AND additional predicate', () => {
		const code = `
			local function id(v)
				return v
			end
			local x = id(...)
			if typeof(x) == "number" and x > 0 then
				local y = x + 1
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('y')).toBe('number');
	});

	test('narrows via not(typeof(x) ~= "number") in then-branch', () => {
		const code = `
			local function id(v)
				return v
			end
			local x = id(...)
			if not (typeof(x) ~= "number") then
				local y = x + 1
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('y')).toBe('number');
	});

	test('narrows via not(typeof(x) == "number") in else-branch', () => {
		const code = `
			local function id(v)
				return v
			end
			local x = id(...)
			if not (typeof(x) == "number") then
				-- no
			else
				local y = x + 1
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('y')).toBe('number');
	});

	test('infers vector instance component fields', () => {
		const code = `
			local v = vector(1,2,3)
			local x = v.x
			local y = v.y
			local z = v.z
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('x')).toBe('number');
		expect(map.get('y')).toBe('number');
		expect(map.get('z')).toBe('number');
	});

	test('infers rotation/quaternion instance component fields and typeof narrowing', () => {
		const code = `
			local r = quaternion(0,0,0,1)
			local rx = r.x
			if typeof(r) == "quaternion" then
				local ry = r.y
			end
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('rx')).toBe('number');
		expect(map.get('ry')).toBe('number');
	});

	test('infers Luau class constructors and public fields', () => {
		const code = `
			class Point
				public x: number
				public y: number
				public function new(x: number, y: number)
					return Point { x = x, y = y }
				end
				function magnitude(self)
					return self.x
				end
			end
			local p = Point.new(1, 2)
			local q = Point { x = 3, y = 4 }
			local x = p.x
			local m = q:magnitude()
		`;
		const parsed = parseSlua(code);
		expect(parsed.ast).toBeTruthy();
		const registry = buildSluaRegistryFromLslDefinitions(null);
		const inferred = inferLocalVariableTypes(parsed.ast, registry);
		const map = new Map(inferred.map((x) => [x.name, sluaTypeToString(x.type)]));
		expect(map.get('p')).toBe('Point');
		expect(map.get('q')).toBe('Point');
		expect(map.get('x')).toBe('number');
		expect(map.get('m')).toBe('number');
	});
});
