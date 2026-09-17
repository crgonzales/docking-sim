function result = conjugateQuat(q)
%CONJUGATEQUAT Reverse a scalar-first Hamilton quaternion rotation.
q = q(:);
if numel(q) ~= 4 || any(~isfinite(q))
    error('docking:InvalidQuaternion', 'Quaternion must be a finite 4x1 vector.');
end
result = [q(1); -q(2); -q(3); -q(4)];
end
