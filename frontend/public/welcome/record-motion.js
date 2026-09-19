/** Keep the entire rotating record in front of the uppermost stationary rim. */
export function recordClearance(
    angle,
    radius = 2.13,
    halfThickness = 0.09,
    stackFront = -0.09,
) {
    return Math.max(
        0,
        radius * Math.abs(Math.sin(angle)) +
            halfThickness * Math.abs(Math.cos(angle)) +
            stackFront +
            0.07,
    );
}
