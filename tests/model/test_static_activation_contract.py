"""Independent checks for the preregistered affine quantization contract."""

import numpy as np
import pytest

from scripts.static_activation_quantize import (
    StaticActivationError,
    compute_quantization_params,
)


@pytest.mark.parametrize(
    ("minimum", "maximum", "extent", "expected_zero"),
    [(-3.0, -1.0, 3.0, 255), (1.0, 4.0, 4.0, 0), (2.0, 2.0, 2.0, 0)],
)
def test_scalar_parameters_include_zero_and_match_stored_float32(
    minimum: float, maximum: float, extent: float, expected_zero: int
) -> None:
    scale, zero = compute_quantization_params(minimum, maximum)
    assert scale == float(np.float32(extent / 255))
    assert zero == expected_zero
    # Positive and negative constants must remain inside the stored range;
    # a tiny epsilon around the constant would saturate almost every value.
    restored_low = -zero * scale
    restored_high = (255 - zero) * scale
    assert restored_low <= min(0, minimum) + 1e-6
    assert restored_high >= max(0, maximum) - 1e-6


def test_unrepresentable_float32_scale_is_rejected() -> None:
    with pytest.raises(StaticActivationError, match="scale"):
        compute_quantization_params(0.0, 1e-50)
