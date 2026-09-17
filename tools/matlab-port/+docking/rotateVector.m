function result = rotateVector(q, vector)
%ROTATEVECTOR Rotate a vector with a scalar-first Hamilton quaternion.
q = docking.normalizeQuat(q);
vector = vector(:);
if numel(vector) ~= 3 || any(~isfinite(vector))
    error('docking:InvalidVector', 'Vector must be a finite 3x1 vector.');
end
rotated = docking.multiplyQuat(docking.multiplyQuat(q, [0; vector]), docking.conjugateQuat(q));
result = rotated(2:4);
end
