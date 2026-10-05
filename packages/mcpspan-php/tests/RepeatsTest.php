<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use McpSpan\Core\Repeats;
use PHPUnit\Framework\TestCase;

final class RepeatsTest extends TestCase
{
    protected function tearDown(): void
    {
        Repeats::forget();
    }

    public function testTellsARepeatOfThePreviousCallToTheToolInTheSessionWhateverTheKeyOrder(): void
    {
        self::assertFalse(Repeats::note('s1', 'search', ['to' => 'WAW', 'n' => 2]));
        self::assertTrue(Repeats::note('s1', 'search', ['n' => 2, 'to' => 'WAW']));
        self::assertFalse(Repeats::note('s1', 'search', ['to' => 'KRK', 'n' => 2]));
        self::assertFalse(Repeats::note('s1', 'book', ['to' => 'KRK', 'n' => 2]));
        self::assertFalse(Repeats::note('s2', 'search', ['to' => 'KRK', 'n' => 2]));
        self::assertFalse(Repeats::note('s1', 'odd', \NAN));
        self::assertFalse(Repeats::note('s1', 'odd', \NAN));
    }

    public function testForgetsTheOldestPairsPastItsBoundAndAPairThatEndedInterim(): void
    {
        Repeats::note('first', 'search', ['to' => 'WAW']);
        for ($i = 0; $i < Repeats::MAX_KEPT; ++$i) {
            Repeats::note("s{$i}", 'search', null);
        }
        self::assertFalse(Repeats::note('first', 'search', ['to' => 'WAW']));

        Repeats::interim('first', 'search');
        self::assertFalse(Repeats::note('first', 'search', ['to' => 'WAW']));
    }

    public function testKnowsARetryAnsweringAnInterimQuestion(): void
    {
        self::assertTrue(Repeats::continuesEarlierCall(['name' => 'a', 'requestState' => 'x']));
        self::assertTrue(Repeats::continuesEarlierCall(['inputResponses' => ['q' => []]]));
        self::assertFalse(Repeats::continuesEarlierCall(['name' => 'a']));
        self::assertFalse(Repeats::continuesEarlierCall(null));
    }
}
