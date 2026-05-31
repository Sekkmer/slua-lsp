import { describe, it, expect } from 'vitest';
import { defaultMetatableRegistry, getSpecificMultiplicationReturnType, getSpecificDivisionReturnType } from '../src/slua/metatables.js';
import { slua } from '../src/slua/types.js';

describe('Metatable Registry', () => {
	it('should have vector metatable registered', () => {
		const vectorMt = defaultMetatableRegistry.get('vector');
		expect(vectorMt).toBeDefined();
		expect(vectorMt?.typeName).toBe('vector');
	});

	it('should have rotation metatable registered', () => {
		const rotationMt = defaultMetatableRegistry.get('rotation');
		expect(rotationMt).toBeDefined();
		expect(rotationMt?.typeName).toBe('rotation');
	});

	it('should have quaternion metatable registered', () => {
		const quaternionMt = defaultMetatableRegistry.get('quaternion');
		expect(quaternionMt).toBeDefined();
		expect(quaternionMt?.typeName).toBe('quaternion');
	});

	it('should have __add metamethod for vector', () => {
		const hasAdd = defaultMetatableRegistry.hasMetamethod('vector', '__add');
		expect(hasAdd).toBe(true);
	});

	it('should have __mul metamethod for vector', () => {
		const hasMul = defaultMetatableRegistry.hasMetamethod('vector', '__mul');
		expect(hasMul).toBe(true);
	});

	it('should have __type metamethod for vector', () => {
		const hasType = defaultMetatableRegistry.hasMetamethod('vector', '__type');
		expect(hasType).toBe(true);
	});

	it('should have __type metamethod for rotation', () => {
		const hasType = defaultMetatableRegistry.hasMetamethod('rotation', '__type');
		expect(hasType).toBe(true);
	});
});

describe('Binary Operations', () => {
	it('should infer vector + vector -> vector', () => {
		const result = defaultMetatableRegistry.getBinaryOperationReturnType(
			slua.vector(),
			slua.vector(),
			'+'
		);
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('vector');
	});

	it('should infer vector - vector -> vector', () => {
		const result = defaultMetatableRegistry.getBinaryOperationReturnType(
			slua.vector(),
			slua.vector(),
			'-'
		);
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('vector');
	});

	it('should infer rotation + rotation -> rotation', () => {
		const result = defaultMetatableRegistry.getBinaryOperationReturnType(
			slua.rotation(),
			slua.rotation(),
			'+'
		);
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('rotation');
	});

	it('should infer rotation * rotation -> rotation', () => {
		// For multiplication, we use the specific function that knows about type combinations
		const result = getSpecificMultiplicationReturnType(slua.rotation(), slua.rotation());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('rotation');
	});
});

describe('Specific Multiplication Operations', () => {
	it('should infer vector * number -> vector', () => {
		const result = getSpecificMultiplicationReturnType(slua.vector(), slua.number());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('vector');
	});

	it('should infer number * vector -> vector', () => {
		const result = getSpecificMultiplicationReturnType(slua.number(), slua.vector());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('vector');
	});

	it('should infer vector * vector -> number (dot product)', () => {
		const result = getSpecificMultiplicationReturnType(slua.vector(), slua.vector());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('primitive');
		expect(result?.kind === 'primitive' && result.name).toBe('number');
	});

	it('should infer vector * rotation -> vector', () => {
		const result = getSpecificMultiplicationReturnType(slua.vector(), slua.rotation());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('vector');
	});

	it('should infer rotation * rotation -> rotation', () => {
		const result = getSpecificMultiplicationReturnType(slua.rotation(), slua.rotation());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('rotation');
	});
});

describe('Specific Division Operations', () => {
	it('should infer vector / number -> vector', () => {
		const result = getSpecificDivisionReturnType(slua.vector(), slua.number());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('vector');
	});

	it('should infer vector / rotation -> vector', () => {
		const result = getSpecificDivisionReturnType(slua.vector(), slua.rotation());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('vector');
	});

	it('should infer rotation / rotation -> rotation', () => {
		const result = getSpecificDivisionReturnType(slua.rotation(), slua.rotation());
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('rotation');
	});
});

describe('Unary Operations', () => {
	it('should infer -vector -> vector', () => {
		const result = defaultMetatableRegistry.getUnaryOperationReturnType(slua.vector(), '-');
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('vector');
	});

	it('should infer -rotation -> rotation', () => {
		const result = defaultMetatableRegistry.getUnaryOperationReturnType(slua.rotation(), '-');
		expect(result).toBeDefined();
		expect(result?.kind).toBe('custom');
		expect(result?.kind === 'custom' && result.name).toBe('rotation');
	});
});

describe('Metamethod Lookup', () => {
	it('should find __add for vector', () => {
		const method = defaultMetatableRegistry.getMetamethod('vector', '__add');
		expect(method).toBeDefined();
		expect(method?.name).toBe('__add');
		expect(method?.signature.kind).toBe('function');
	});

	it('should find __mul for vector', () => {
		const method = defaultMetatableRegistry.getMetamethod('vector', '__mul');
		expect(method).toBeDefined();
		expect(method?.name).toBe('__mul');
	});

	it('should find __type for vector', () => {
		const method = defaultMetatableRegistry.getMetamethod('vector', '__type');
		expect(method).toBeDefined();
		expect(method?.name).toBe('__type');
	});

	it('should find __type for rotation', () => {
		const method = defaultMetatableRegistry.getMetamethod('rotation', '__type');
		expect(method).toBeDefined();
		expect(method?.name).toBe('__type');
	});

	it('should find __index for vector', () => {
		const method = defaultMetatableRegistry.getMetamethod('vector', '__index');
		expect(method).toBeDefined();
		expect(method?.name).toBe('__index');
	});

	it('should find __tostring for vector', () => {
		const method = defaultMetatableRegistry.getMetamethod('vector', '__tostring');
		expect(method).toBeDefined();
		expect(method?.name).toBe('__tostring');
	});
});
