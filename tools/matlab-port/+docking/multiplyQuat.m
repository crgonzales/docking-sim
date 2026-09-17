function result = multiplyQuat(a, b)
%MULTIPLYQUAT Hamilton scalar-first quaternion product.
a = a(:); b = b(:);
if numel(a) ~= 4 || numel(b) ~= 4 || any(~isfinite([a; b]))
    error('docking:InvalidQuaternion', 'Quaternion operands must be finite 4x1 vectors.');
end
result = [a(1)*b(1) - a(2)*b(2) - a(3)*b(3) - a(4)*b(4); ...
          a(1)*b(2) + a(2)*b(1) + a(3)*b(4) - a(4)*b(3); ...
          a(1)*b(3) - a(2)*b(4) + a(3)*b(1) + a(4)*b(2); ...
          a(1)*b(4) + a(2)*b(3) - a(3)*b(2) + a(4)*b(1)];
end
